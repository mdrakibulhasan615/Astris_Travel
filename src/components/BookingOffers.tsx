import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, X } from 'lucide-react';
import type { AffiliateOffer, OfferProviderId, TransitOption } from '../../shared/types.ts';
import { PROVIDER_NAMES } from '../../shared/affiliate.ts';
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
  footnote,
  cardRef,
  onClose,
}: {
  id: string;
  label: string;
  rows: OfferRow[];
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
  footnote,
  accent,
  cardRef,
}: {
  id: string;
  label: string;
  rows: OfferRow[];
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

  if (rows.length === 0) return null;
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
      {open && <OffersPanel id={id} label={label} rows={rows} footnote={footnote} cardRef={cardRef} onClose={close} />}
    </>
  );
}

/** A boarding pass's booking button: the flight's merchants, cheapest first. */
export function BookingButton({
  option,
  accent,
  discountUsd,
  cardRef,
}: {
  option: TransitOption;
  /** The ticket's brand colours (matches the card header). */
  accent: CSSProperties;
  discountUsd: number;
  cardRef: RefObject<HTMLElement | null>;
}) {
  const rows = useMemo<OfferRow[]>(
    () =>
      [...offersOf(option)]
        .sort((a, b) => a.priceUsd - b.priceUsd)
        // The same voucher discount applies to every merchant, so the order is unchanged
        .map((o) => ({
          key: o.providerId,
          name: o.provider,
          badge: o.logo,
          priceUsd: Math.max(0, o.priceUsd - discountUsd),
          url: o.url,
          title: `Opens ${o.provider} with this route, date and travellers filled in`,
        })),
    [option, discountUsd]
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
