import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ExternalLink, Luggage, RefreshCw, X } from 'lucide-react';
import type { TransitOption } from '../../shared/types.ts';
import {
  postDataFields,
  sortSellerOptions,
  type BookingOptionsResponse,
  type BookingRequest,
  type LiveFlightErrorBody,
  type ReturnFlightsResponse,
  type SellerBookingOption,
} from '../../shared/liveFlights.ts';
import { formatDuration } from '../../shared/smartScore.ts';
import { useCurrency } from '../currency.tsx';

/**
 * "Book Exact Ticket": the sellers of one specific fare (the airline itself and travel agencies),
 * each with its own price, baggage fees and a link that opens ITS checkout for exactly this ticket.
 * Every open that is not cached spends a SerpApi search, so nothing here runs until the traveller
 * clicks (and the server caches a ticket's seller list for 15 minutes).
 */

// ── The handoff: a POST form when Google gave us a body, a plain link when it did not ───────────

/**
 * Opens a seller's checkout in a new tab. With `postData` the request must be a POST carrying that
 * exact body, so it is a real form whose hidden inputs are the decoded fields: the browser encodes
 * them again on submit and the body that reaches the seller is the original one.
 */
export function SellerAction({ request, bookWith, primary }: { request: BookingRequest; bookWith: string; primary?: boolean }) {
  const className = `inline-flex shrink-0 cursor-pointer items-center justify-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-1 ${
    primary ? 'bg-orange-500 text-white hover:bg-orange-600' : 'bg-slate-100 text-slate-800 hover:bg-slate-200'
  }`;
  const label = (
    <>
      Proceed to {bookWith}
      <ExternalLink className="h-3 w-3" aria-hidden="true" />
    </>
  );

  if (request.postData) {
    return (
      <form method="POST" action={request.url} target="_blank" rel="noopener noreferrer" className="shrink-0">
        {postDataFields(request.postData).map(([name, value], i) => (
          <input key={`${name}-${i}`} type="hidden" name={name} value={value} />
        ))}
        <button type="submit" className={className}>
          {label}
        </button>
      </form>
    );
  }
  return (
    <a href={request.url} target="_blank" rel="noopener noreferrer" className={className}>
      {label}
    </a>
  );
}

// ── Data loading ─────────────────────────────────────────────────────────────────────────────────

type Failure = { code: LiveFlightErrorBody['error'] | 'NETWORK'; message: string };

async function postJson<T>(url: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; failure: Failure }> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (res.ok) return { ok: true, data: data as T };
    const err = data as LiveFlightErrorBody | null;
    return { ok: false, failure: { code: err?.error ?? 'UPSTREAM_ERROR', message: err?.message ?? 'The request failed.' } };
  } catch {
    return { ok: false, failure: { code: 'NETWORK', message: 'Could not reach the server. Check your connection.' } };
  }
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <ul aria-busy="true" aria-label="Loading" className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex animate-pulse items-center justify-between gap-3 rounded-xl border border-slate-100 p-3">
          <div className="space-y-2">
            <div className="h-3.5 w-32 rounded bg-slate-200" />
            <div className="h-2.5 w-48 rounded bg-slate-100" />
          </div>
          <div className="h-8 w-28 rounded-lg bg-slate-200" />
        </li>
      ))}
    </ul>
  );
}

function ErrorBox({ failure, onRetry, onRefresh }: { failure: Failure; onRetry: () => void; onRefresh?: () => void }) {
  const expired = failure.code === 'TOKEN_EXPIRED';
  const quota = failure.code === 'QUOTA_EXCEEDED';
  return (
    <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="space-y-2">
          <p className="font-semibold">
            {expired ? 'This fare has expired' : quota ? 'Live lookups are used up for now' : 'Could not load the sellers'}
          </p>
          <p>
            {expired
              ? 'Fares change quickly. Fetch live fares again to get current prices and sellers.'
              : quota
                ? 'The free monthly search allowance is spent. Use the route links on the leg to compare on a booking site.'
                : failure.message}
          </p>
          <div className="flex flex-wrap gap-2">
            {expired && onRefresh && (
              <button type="button" onClick={onRefresh} className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-orange-500 px-3 py-1.5 font-bold text-white hover:bg-orange-600">
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                Refresh live fares
              </button>
            )}
            {!expired && !quota && (
              <button type="button" onClick={onRetry} className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-white px-3 py-1.5 font-bold text-slate-800 ring-1 ring-amber-300 hover:bg-amber-100">
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                Try again
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sellers ──────────────────────────────────────────────────────────────────────────────────────

function SellerRows({ options }: { options: SellerBookingOption[] }) {
  const { fmt } = useCurrency();
  const sorted = useMemo(() => sortSellerOptions(options), [options]);
  const lowest = sorted[0]?.groupPrice;

  // Rows of one split purchase (departing + returning) sit together under one header
  const groups: SellerBookingOption[][] = [];
  for (const o of sorted) {
    const last = groups[groups.length - 1];
    if (last && last[0].groupId === o.groupId) last.push(o);
    else groups.push([o]);
  }

  return (
    <ul className="space-y-2">
      {groups.map((rows) => {
        const first = rows[0];
        const isLowest = first.groupPrice === lowest;
        return (
          <li
            key={first.groupId}
            className={`rounded-xl border p-3 ${first.isAirlineDirect ? 'border-orange-300 bg-orange-50/50' : 'border-slate-200 bg-white'}`}
          >
            {first.separateTickets && (
              <div className="mb-1.5 text-[11px] font-semibold text-slate-600">
                Two separate tickets · total <span className="tabular-nums text-slate-900">{fmt(first.groupPrice)}</span>
              </div>
            )}
            <div className="space-y-3">
              {rows.map((o) => (
                <div key={o.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-bold text-slate-900">{o.bookWith}</span>
                      {o.isAirlineDirect && (
                        <span className="rounded-md bg-orange-500 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">Airline direct</span>
                      )}
                      {isLowest && o.part !== 'returning' && (
                        <span className="rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-emerald-800">Lowest price</span>
                      )}
                      {o.separateTickets && (
                        <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                          {o.part === 'departing' ? 'Outbound' : 'Return'}
                        </span>
                      )}
                    </div>
                    <div className="font-display text-lg font-extrabold leading-none text-slate-900 tabular-nums">{fmt(o.price)}</div>
                    {o.optionTitle && <div className="text-[11px] text-slate-500">{o.optionTitle}</div>}
                    {o.baggagePrices.length > 0 && (
                      <ul className="space-y-0.5 text-[11px] text-slate-600">
                        {o.baggagePrices.map((b, i) => (
                          <li key={i} className="flex items-center gap-1">
                            <Luggage className="h-3 w-3 shrink-0 text-slate-400" aria-hidden="true" />
                            {b}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <SellerAction request={o.bookingRequest} bookWith={o.bookWith} primary={first.isAirlineDirect || isLowest} />
                </div>
              ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ── The modal ────────────────────────────────────────────────────────────────────────────────────

type Step =
  | { kind: 'loading'; what: 'returns' | 'sellers' }
  | { kind: 'returns'; options: TransitOption[] }
  | { kind: 'sellers'; options: SellerBookingOption[]; fromCache: boolean }
  | { kind: 'error'; failure: Failure; retry: () => void };

/** One return-flight choice (round trips: the outbound is picked first, then the way back). */
function ReturnChoice({ option, onPick }: { option: TransitOption; onPick: () => void }) {
  const { fmt } = useCurrency();
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-3">
      <div className="min-w-0 text-xs text-slate-700">
        <div className="font-bold text-slate-900">
          {option.carrier} · {option.routeCode}
        </div>
        <div className="tabular-nums">
          {option.departureTime} → {option.arrivalTime} · {formatDuration(option.inVehicleHours + option.layoverHours)} ·{' '}
          {option.stopsCount === 0 ? 'Nonstop' : `${option.stopsCount} stop${option.stopsCount > 1 ? 's' : ''}`}
        </div>
        <div className="text-[11px] text-slate-500">{option.baggageSummary ?? 'Baggage not stated'}</div>
      </div>
      <div className="flex items-center gap-3">
        <span className="font-display text-base font-extrabold tabular-nums text-slate-900">{fmt(option.basePriceUsd)}</span>
        <button type="button" onClick={onPick} className="cursor-pointer rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-orange-600">
          Choose
        </button>
      </div>
    </li>
  );
}

export function SellerModal({
  option,
  passengers,
  onClose,
  onRefreshLive,
}: {
  option: TransitOption;
  passengers: number;
  onClose: () => void;
  /** Re-runs "Fetch Live Fares" for the leg (the way out of an expired token). */
  onRefreshLive?: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: 'loading', what: option.bookingToken ? 'sellers' : 'returns' });
  const panelRef = useRef<HTMLDivElement>(null);
  // A stale answer (the modal was closed and reopened, or a retry raced) must not overwrite a newer one
  const run = useRef(0);
  // The card re-renders with a new `option` object whenever the itinerary does; the lookups must keep
  // using the one that was open, and must not restart (every restart is another seller request)
  const optionRef = useRef(option);
  const passengersRef = useRef(passengers);

  const loadSellers = useCallback(async (bookingToken: string) => {
    const id = ++run.current;
    setStep({ kind: 'loading', what: 'sellers' });
    // The token only works together with the search it came from (a chosen return flight too)
    const res = await postJson<BookingOptionsResponse>('/api/flights/booking-options', {
      bookingToken,
      search: optionRef.current.liveSearch,
    });
    if (id !== run.current) return;
    setStep(
      res.ok
        ? { kind: 'sellers', options: res.data.options, fromCache: res.data.cached }
        : { kind: 'error', failure: res.failure, retry: () => void loadSellers(bookingToken) }
    );
  }, []);

  const loadReturns = useCallback(async () => {
    const id = ++run.current;
    const option = optionRef.current;
    const search = option.liveSearch;
    if (!option.departureToken || !search?.returnDate) {
      setStep({ kind: 'error', failure: { code: 'BAD_REQUEST', message: 'This fare cannot be booked from here.' }, retry: () => undefined });
      return;
    }
    setStep({ kind: 'loading', what: 'returns' });
    const res = await postJson<ReturnFlightsResponse>('/api/flights/return-flights', {
      ...search,
      departureToken: option.departureToken,
      adults: 1,
      passengers: passengersRef.current,
    });
    if (id !== run.current) return;
    setStep(
      res.ok
        ? { kind: 'returns', options: res.data.options }
        : { kind: 'error', failure: res.failure, retry: () => void loadReturns() }
    );
  }, []);

  // Opening the modal is the click that spends the lookup
  useEffect(() => {
    const first = optionRef.current;
    if (first.bookingToken) void loadSellers(first.bookingToken);
    else void loadReturns();
    return () => {
      run.current++;
    };
  }, [loadSellers, loadReturns]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const title = `${option.carrier} · ${option.routeCode}`;

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Book exact ticket: ${title}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl focus:outline-none sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-wide text-orange-600">Book exact ticket</div>
            <div className="truncate text-sm font-bold text-slate-900">{title}</div>
            <div className="text-[11px] tabular-nums text-slate-500">
              {option.departureTime} → {option.arrivalTime}
              {option.returnDate ? ` · back ${option.returnDate}` : ''}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="cursor-pointer rounded-md p-1 text-slate-500 hover:bg-slate-100">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-3 overflow-y-auto px-4 py-3">
          {step.kind === 'loading' && (
            <>
              <p className="text-xs text-slate-500">
                {step.what === 'returns' ? 'Finding return flights for this outbound…' : 'Asking the sellers for their prices…'}
              </p>
              <Skeleton rows={step.what === 'returns' ? 4 : 3} />
            </>
          )}

          {step.kind === 'returns' && (
            <>
              <p className="text-xs font-semibold text-slate-700">Choose your return flight. The price shown is the round-trip total.</p>
              {step.options.length === 0 ? (
                <p className="text-xs text-slate-500">No return flights were found for this outbound.</p>
              ) : (
                <ul className="space-y-2">
                  {step.options.map((r) => (
                    <ReturnChoice key={r.id} option={r} onPick={() => r.bookingToken && void loadSellers(r.bookingToken)} />
                  ))}
                </ul>
              )}
            </>
          )}

          {step.kind === 'sellers' && (
            <>
              <SellerRows options={step.options} />
              <p className="text-[10px] leading-snug text-slate-500">
                Prices are live from the sellers and can change at checkout. The link opens the seller's own page for this exact ticket in a new tab.
              </p>
            </>
          )}

          {step.kind === 'error' && (
            <ErrorBox
              failure={step.failure}
              onRetry={step.retry}
              onRefresh={
                onRefreshLive
                  ? () => {
                      onRefreshLive();
                      onClose();
                    }
                  : undefined
              }
            />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

/** The card's "Book Exact Ticket" button: opens the seller modal for this fare. */
export function BookExactButton({
  option,
  passengers = 1,
  onRefreshLive,
}: {
  option: TransitOption;
  passengers?: number;
  onRefreshLive?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        aria-haspopup="dialog"
        className="inline-flex w-full cursor-pointer items-center justify-center whitespace-nowrap rounded-lg bg-[#FF812E] px-1.5 py-1 text-[10px] font-bold uppercase tracking-normal text-white hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E] focus-visible:ring-offset-1"
      >
        Book Exact Ticket
      </button>
      {open && <SellerModal option={option} passengers={passengers} onClose={close} onRefreshLive={onRefreshLive} />}
    </>
  );
}
