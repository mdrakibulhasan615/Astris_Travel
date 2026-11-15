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

const BADGES: Record<OfferProviderId, { bg: string; glyph: string }> = {
  aviasales: { bg: '#0A8CFF', glyph: 'A' },
  tripcom: { bg: '#287DFA', glyph: 'T' },
  kiwi: { bg: '#00A991', glyph: 'k' },
  skyscanner: { bg: '#0770E3', glyph: 'S' },
  'google-flights': { bg: '#EA4335', glyph: 'G' },
};

function MerchantBadge({ id }: { id: OfferProviderId }) {
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

function OffersPanel({
  option,
  offers,
  discountUsd,
  cardRef,
  onClose,
}: {
  option: TransitOption;
  offers: AffiliateOffer[];
  discountUsd: number;
  cardRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const { fmt } = useCurrency();
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  // Cheapest first; the same voucher discount applies to every merchant, so the order is unchanged
  const rows = useMemo(
    () =>
      [...offers]
        .sort((a, b) => a.priceUsd - b.priceUsd)
        .map((o) => ({ ...o, net: Math.max(0, o.priceUsd - discountUsd) })),
    [offers, discountUsd]
  );
  const anyEstimated = rows.some((r) => r.estimated);

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
        aria-label={`Booking options for ${option.carrier}`}
        data-offers-panel={option.id}
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
            <li key={row.providerId} className="flex items-center justify-between gap-3 px-2 py-2.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <MerchantBadge id={row.logo} />
                <div className="min-w-0">
                  <div className="whitespace-nowrap font-display text-[15px] font-extrabold leading-tight text-slate-900 tabular-nums">
                    {fmt(row.net)}
                  </div>
                  <div className="truncate text-[11px] text-slate-500">{row.provider}</div>
                </div>
              </div>
              <a
                href={row.url}
                target="_blank"
                rel="sponsored noopener noreferrer"
                title={`Opens ${row.provider} with this route, date and travellers filled in`}
                className={`inline-flex min-w-[4.5rem] shrink-0 items-center justify-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-1 ${
                  i === 0
                    ? 'bg-orange-500 text-white hover:bg-orange-600'
                    : 'bg-slate-100 text-slate-800 hover:bg-slate-200'
                }`}
              >
                Buy
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
        {anyEstimated && (
          <p className="px-2 pb-1 pt-1.5 text-[10px] leading-snug text-slate-500">
            {option.dataSource === 'live'
              ? 'Only the cheapest price is the live fare; other partners are estimates, confirmed on their site.'
              : option.dataSource === 'cached'
                ? 'Aviasales shows a real fare seen in the last 48 hours; it may have changed. Other partners are estimates.'
                : 'Sample data: prices are illustrative, confirmed on the partner site.'}
          </p>
        )}
      </div>
    </>,
    document.body
  );
}

/**
 * The `PROCEED TO BOOKING` button on a boarding pass stub. Opens a floating panel that compares the
 * merchants selling this flight, cheapest first (orange Buy button on the cheapest).
 */
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
  const offers = useMemo(() => offersOf(option), [option]);
  const active = useActiveOption();
  const open = active === option.id;
  const close = useCallback(() => setActive(null), []);

  // A card that goes away (list re-ranked, leg collapsed) must not leave its panel behind
  useEffect(() => () => (activeOptionId === option.id ? setActive(null) : undefined), [option.id]);

  if (offers.length === 0) return null;
  return (
    <>
      <button
        type="button"
        data-offers-trigger
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setActive(open ? null : option.id);
        }}
        style={accent}
        className="inline-flex w-full items-center justify-center whitespace-nowrap rounded-lg px-1.5 py-1 text-[10px] font-bold uppercase tracking-normal hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E] focus-visible:ring-offset-1"
      >
        Proceed to booking
      </button>
      {open && (
        <OffersPanel option={option} offers={offers} discountUsd={discountUsd} cardRef={cardRef} onClose={close} />
      )}
    </>
  );
}
