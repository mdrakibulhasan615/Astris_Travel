import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Clock, ExternalLink, Loader2, X } from 'lucide-react';
import type { AffiliateOffer, OfferProviderId, TransitOption } from '../../shared/types.ts';
import { PROVIDER_NAMES } from '../../shared/affiliate.ts';
import { ulccCarrier } from '../../shared/ulcc.ts';
import type { CheckoutErrorResponse, CheckoutResponse } from '../../shared/flights.ts';
import { useCurrency } from '../currency.tsx';

// ── One panel open at a time: opening another card's panel switches to it ──────────────────────

let activeOptionId: string | null = null;
const listeners = new Set<() => void>();
const setActive = (id: string | null) => {
  if (activeOptionId === id) return;
  activeOptionId = id;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const useActiveOption = () => useSyncExternalStore(subscribe, () => activeOptionId, () => null);

// ── Merchant badges (drawn, not fetched: no external images) ───────────────────────────────────

const BADGES: Record<string, { bg: string; glyph: string }> = {
  booking: { bg: '#003B95', glyph: 'B' },
  agoda: { bg: '#5C2D91', glyph: 'a' },
  'trip-hotels': { bg: '#287DFA', glyph: 'T' },
  'google-hotels': { bg: '#4285F4', glyph: 'G' },
  aviasales: { bg: '#0A8CFF', glyph: 'A' },
  tripcom: { bg: '#287DFA', glyph: 'T' },
  kiwi: { bg: '#00A991', glyph: 'k' },
  skyscanner: { bg: '#0770E3', glyph: 'S' },
  'google-flights': { bg: '#EA4335', glyph: 'G' },
};

function MerchantBadge({ id }: { id: string }) {
  const b = BADGES[id] ?? { bg: '#6B7280', glyph: '?' };
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg font-display text-sm font-black text-white"
      style={{ background: b.bg }}
    >
      {b.glyph}
    </span>
  );
}

/**
 * The ticket's offers, falling back to a single row from the ticket's own booking link for options
 * that predate offers (e.g. restored from an older session).
 */
function offersOf(option: TransitOption): AffiliateOffer[] {
  if (option.offers && option.offers.length > 0) return option.offers;
  if (!option.bookingUrl) return [];
  const id: OfferProviderId = 'tripcom';
  return [
    {
      providerId: id,
      provider: option.bookingProvider ? PROVIDER_NAMES[option.bookingProvider] : 'Partner site',
      logo: id,
      priceUsd: option.basePriceUsd,
      url: option.bookingUrl,
      estimated: option.dataSource !== 'live',
    },
  ];
}

const PANEL_WIDTH = 264;
const GAP = 10;
const EDGE = 8;

interface Placement {
  mode: 'side' | 'modal';
  style: CSSProperties;
}

/** Side of the ticket when there is room to its right (desktop), else a centred floating modal. */
function place(card: HTMLElement | null, panelHeight: number): Placement | null {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rect = card?.getBoundingClientRect();
  if (rect && (rect.bottom < 0 || rect.top > vh)) return null; // scrolled out of view
  if (rect && vw >= 768 && vw - rect.right - GAP - EDGE >= 220) {
    const width = Math.min(PANEL_WIDTH, vw - rect.right - GAP - EDGE);
    const top = Math.max(EDGE, Math.min(rect.top, vh - panelHeight - EDGE));
    return { mode: 'side', style: { position: 'fixed', left: rect.right + GAP, top, width } };
  }
  return {
    mode: 'modal',
    style: {
      position: 'fixed',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
      width: Math.min(PANEL_WIDTH + 40, vw - 2 * EDGE * 2),
    },
  };
}

/** One merchant row in the floating panel. A row without a price shows "Check price" instead. */
export interface OfferRow {
  key: string;
  name: string;
  badge: string;
  /** Net price in USD (converted for display); omit when the merchant's price is not known. */
  priceUsd?: number;
  url: string;
  title?: string;
}

function OffersPanel({
  id,
  label,
  rows,
  body,
  footnote,
  cardRef,
  onClose,
}: {
  id: string;
  label: string;
  rows: OfferRow[];
  /** Replaces the merchant rows (the Duffel checkout panel). */
  body?: ReactNode;
  footnote?: string;
  cardRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const { fmt } = useCurrency();
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const reposition = useCallback(() => {
    const next = place(cardRef.current, panelRef.current?.offsetHeight ?? 260);
    if (!next) onClose();
    else setPlacement(next);
  }, [cardRef, onClose]);

  useLayoutEffect(() => {
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true); // capture: the itinerary pane scrolls, not the window
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [reposition]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (panelRef.current?.contains(t)) return;
      if (t?.closest?.('[data-offers-trigger]')) return; // the trigger toggles / switches the panel itself
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [onClose]);

  const modal = placement?.mode === 'modal';

  return createPortal(
    <>
      {modal && <div aria-hidden="true" className="fixed inset-0 z-[60] bg-black/20" />}
      <div
        ref={panelRef}
        role="dialog"
        aria-label={label}
        data-offers-panel={id}
        onClick={(e) => e.stopPropagation()}
        style={placement?.style ?? { position: 'fixed', visibility: 'hidden', width: PANEL_WIDTH }}
        className="z-[61] rounded-2xl border-2 border-orange-500 bg-white p-2 shadow-xl"
      >
        {modal && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close booking options"
            className="absolute right-2 top-2 rounded-md p-1 text-slate-500 hover:bg-slate-100"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        {body}
        <ul className="divide-y divide-slate-100">
          {rows.map((row, i) => (
            <li key={row.key} className="flex items-center justify-between gap-3 px-2 py-2.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <MerchantBadge id={row.badge} />
                <div className="min-w-0">
                  <div className="whitespace-nowrap font-display text-[15px] font-extrabold leading-tight text-slate-900 tabular-nums">
                    {row.priceUsd === undefined ? (
                      <span className="text-xs font-semibold text-slate-500">Check price</span>
                    ) : (
                      fmt(row.priceUsd)
                    )}
                  </div>
                  <div className="truncate text-[11px] text-slate-500">{row.name}</div>
                </div>
              </div>
              <a
                href={row.url}
                target="_blank"
                rel="sponsored noopener noreferrer"
                title={row.title ?? `Opens ${row.name}`}
                className={`inline-flex min-w-[4.5rem] shrink-0 items-center justify-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-1 ${
                  i === 0
                    ? 'bg-orange-500 text-white hover:bg-orange-600'
                    : 'bg-slate-100 text-slate-800 hover:bg-slate-200'
                }`}
              >
                {row.priceUsd === undefined ? 'View' : 'Buy'}
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
        {footnote && <p className="px-2 pb-1 pt-1.5 text-[10px] leading-snug text-slate-500">{footnote}</p>}
      </div>
    </>,
    document.body
  );
}

/**
 * A `PROCEED TO BOOKING` button that opens the floating comparison panel for one card (a flight's
 * merchants, a hotel's booking sites). One panel is open at a time; Escape, an outside click or
 * scrolling the card out of view closes it.
 */
export function OffersButton({
  id,
  label,
  rows,
  body,
  footnote,
  accent,
  cardRef,
}: {
  id: string;
  label: string;
  rows: OfferRow[];
  body?: ReactNode;
  footnote?: string;
  /** The card's brand colours; the default is the app's orange. */
  accent?: CSSProperties;
  cardRef: RefObject<HTMLElement | null>;
}) {
  const active = useActiveOption();
  const open = active === id;
  const close = useCallback(() => setActive(null), []);

  // A card that goes away (list re-ranked, leg collapsed) must not leave its panel behind
  useEffect(() => () => (activeOptionId === id ? setActive(null) : undefined), [id]);

  if (rows.length === 0 && !body) return null;
  return (
    <>
      <button
        type="button"
        data-offers-trigger
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setActive(open ? null : id);
        }}
        style={accent ?? { background: '#FF812E', color: '#FFFFFF' }}
        className="inline-flex w-full items-center justify-center whitespace-nowrap rounded-lg px-1.5 py-1 text-[10px] font-bold uppercase tracking-normal hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E] focus-visible:ring-offset-1"
      >
        Proceed to booking
      </button>
      {open && <OffersPanel id={id} label={label} rows={rows} body={body} footnote={footnote} cardRef={cardRef} onClose={close} />}
    </>
  );
}

// ── Duffel offers: our own price panel and "Select & Book" ──────────────────────────────────────

/** `Date.now()` that re-renders every `ms`, for the offer countdown. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

/** Show the validity note only when it matters: the last 10 minutes of an offer. */
const EXPIRY_WARNING_MS = 10 * 60 * 1000;

/**
 * The panel for a bookable Duffel fare: total, the airline fare plus our service fee, how long the
 * offer is still valid, and the button that opens Duffel's hosted checkout. The server re-checks the
 * offer and the price before it hands out the checkout link.
 */
function DuffelCheckout({ option, passengers }: { option: TransitOption; passengers: number }) {
  const { fmt } = useCurrency();
  const pricing = option.pricing!;
  const now = useNow(15_000);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // After a price change the traveller confirms the new total by clicking again
  const [acceptedTotal, setAcceptedTotal] = useState<number | null>(null);

  // USD (the app's display base) per unit of the offer's own currency
  const usdPerUnit = pricing.displayTotal > 0 ? option.basePriceUsd / pricing.displayTotal : 0;
  const baseUsd = pricing.baseFare * usdPerUnit;
  const feeUsd = pricing.serviceFee * usdPerUnit;

  const msLeft = option.expiresAt ? Date.parse(option.expiresAt) - now : Infinity;
  const expired = msLeft <= 0;
  const expiring = !expired && msLeft <= EXPIRY_WARNING_MS;

  const book = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/flights/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offerId: option.offerId,
          slices: option.checkout?.slices ?? [],
          passengers,
          cabinClass: option.checkout?.cabinClass,
          expectedTotal: acceptedTotal ?? pricing.displayTotal,
          currency: pricing.currency,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as CheckoutResponse;
        window.location.assign(data.checkoutUrl);
        return; // leaving the page: keep the button busy
      }
      const err = (await res.json().catch(() => null)) as CheckoutErrorResponse | null;
      if (err?.error === 'price_changed' && err.pricing) {
        setAcceptedTotal(err.pricing.displayTotal);
        setMessage(`The price is now ${fmt(err.pricing.displayTotal * usdPerUnit)}. Select & Book again to continue.`);
      } else {
        setMessage(err?.message ?? 'Booking could not be started. Try again.');
      }
    } catch {
      setMessage('Could not reach the booking service. Check your connection and try again.');
    }
    setBusy(false);
  };

  return (
    <div className="space-y-2 px-2 pb-1 pt-1.5">
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          {option.ticketType === 'return' ? 'Return total · per person' : 'Total · per person'}
        </div>
        <div className="font-display text-2xl font-extrabold leading-tight text-slate-900 tabular-nums">
          {fmt(acceptedTotal !== null ? acceptedTotal * usdPerUnit : option.basePriceUsd)}
        </div>
      </div>

      <dl className="space-y-0.5 text-[11px] text-slate-600 tabular-nums">
        <div className="flex justify-between gap-3">
          <dt>Base fare ({option.carrier})</dt>
          <dd className="font-semibold text-slate-800">{fmt(baseUsd)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Service fee</dt>
          <dd className="font-semibold text-slate-800">{fmt(feeUsd)}</dd>
        </div>
      </dl>

      {(expiring || expired) && (
        <p
          role="status"
          className={`flex items-center gap-1 text-[11px] font-medium ${expired ? 'text-red-600' : 'text-amber-600'}`}
        >
          <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
          {expired
            ? 'This fare has expired. Search again for current prices.'
            : `Fare valid for about ${Math.max(1, Math.ceil(msLeft / 60000))} more min`}
        </p>
      )}

      <button
        type="button"
        onClick={() => void book()}
        disabled={busy || expired}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-orange-500 px-3 py-2 text-xs font-bold text-white hover:bg-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-1 disabled:cursor-default disabled:opacity-60"
      >
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
        {busy ? 'Opening checkout…' : 'Select & Book'}
      </button>

      {message && (
        <p role="alert" className="text-[11px] leading-snug text-red-600">
          {message}
        </p>
      )}
      <p className="text-[10px] leading-snug text-slate-500">
        You enter passenger details and pay on Duffel's secure checkout. The airline issues your ticket there.
      </p>
    </div>
  );
}

/** A boarding pass's booking button: the flight's merchants, cheapest first. */
export function BookingButton({
  option,
  accent,
  cardRef,
  passengers = 1,
}: {
  option: TransitOption;
  /** The ticket's brand colours (matches the card header). */
  accent: CSSProperties;
  cardRef: RefObject<HTMLElement | null>;
  /** Party size, sent to the checkout. */
  passengers?: number;
}) {
  // Airlines Duffel does not sell: straight to the partner, no checkout call
  if (option.source === 'external_ulcc' && option.affiliateUrl) {
    const name = ulccCarrier(option.carrierCode)?.name ?? option.carrier;
    return (
      <a
        href={option.affiliateUrl}
        target="_blank"
        rel="sponsored noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        title={`Opens ${name} fares on our partner's site`}
        className="inline-flex w-full items-center justify-center gap-1 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-1.5 py-1 text-[10px] font-bold text-slate-800 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E] focus-visible:ring-offset-1"
      >
        Book direct on {name}
        <ExternalLink className="h-3 w-3" aria-hidden="true" />
      </a>
    );
  }
  if (option.source === 'duffel' && option.pricing && option.offerId) {
    return (
      <OffersButton
        id={option.id}
        label={`Book ${option.carrier}`}
        rows={[]}
        body={<DuffelCheckout option={option} passengers={passengers} />}
        accent={accent}
        cardRef={cardRef}
      />
    );
  }
  const rows = useMemo<OfferRow[]>(
    () =>
      [...offersOf(option)]
        .sort((a, b) => a.priceUsd - b.priceUsd)
        .map((o) => ({
          key: o.providerId,
          name: o.provider,
          badge: o.logo,
          priceUsd: o.priceUsd,
          url: o.url,
          title: `Opens ${o.provider} with this route, date and travellers filled in`,
        })),
    [option]
  );
  const anyEstimated = useMemo(() => offersOf(option).some((o) => o.estimated), [option]);
  const footnote = !anyEstimated
    ? undefined
    : option.dataSource === 'live'
      ? 'Only the cheapest price is the live fare; other partners are estimates, confirmed on their site.'
      : option.dataSource === 'cached'
        ? 'Aviasales shows a real fare seen in the last 48 hours; it may have changed. Other partners are estimates.'
        : 'Sample data: prices are illustrative, confirmed on the partner site.';
  return (
    <OffersButton
      id={option.id}
      label={`Booking options for ${option.carrier}`}
      rows={rows}
      footnote={footnote}
      accent={accent}
      cardRef={cardRef}
    />
  );
}
