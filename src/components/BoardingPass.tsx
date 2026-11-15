import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { Backpack, Check, Luggage, Plane } from 'lucide-react';
import { formatDuration } from '../../shared/smartScore.ts';
import { describeBaggageStub } from '../../shared/ticketDetails.ts';
import type { OptionTag, TransitOption } from '../../shared/types.ts';
import { ticketAirlines, ticketPalette } from '../utils/airlineColors.ts';
import { useCurrency } from '../currency.tsx';
import { SmartScoreBadge } from './SmartScoreBadge.tsx';

const TAG_LABELS: Record<OptionTag, string> = {
  cheapest: 'Cheapest',
  'cheapest-direct': 'Cheapest Direct',
  direct: 'Direct',
};

/** `Cheapest` / `Cheapest Direct` / `Direct` badge (ranking tags, see shared/ranking.ts). */
export function TagPill({ tag }: { tag: OptionTag }) {
  return (
    <span
      className={`rounded-full px-2 py-px text-[10px] font-semibold whitespace-nowrap ${
        tag === 'direct'
          ? 'bg-neutral-100 text-[#374151]'
          : 'border border-[#BBF7D0] bg-[#F0FDF4] text-[#15803D]'
      }`}
    >
      {TAG_LABELS[tag]}
    </span>
  );
}

// ── Barcodes (decorative; seeded from the ticket so each one looks different but stays stable) ──

export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function Barcode({
  seed,
  vertical = false,
  className = '',
}: {
  seed: string;
  vertical?: boolean;
  className?: string;
}) {
  const bars = useMemo(() => {
    const rand = seededRandom(seed);
    const out: { at: number; size: number }[] = [];
    let cursor = 0;
    while (cursor < 150) {
      const size = 1 + Math.floor(rand() * 3);
      out.push({ at: cursor, size });
      cursor += size + 1 + Math.floor(rand() * 2);
    }
    return { out, length: cursor };
  }, [seed]);

  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox={vertical ? `0 0 20 ${bars.length}` : `0 0 ${bars.length} 20`}
      preserveAspectRatio="none"
      fill="currentColor"
    >
      {bars.out.map((b, i) =>
        vertical ? (
          <rect key={i} x={0} y={b.at} width={20} height={b.size} />
        ) : (
          <rect key={i} x={b.at} y={0} width={b.size} height={20} />
        )
      )}
    </svg>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

export const TONE = { good: 'text-[#15803D]', warn: 'text-[#B45309]', muted: 'text-[#4B5563]' } as const;

export function ticketDate(iso: string | undefined, withYear = true): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '—';
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`)
    .toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      ...(withYear ? { year: 'numeric' as const } : {}),
      timeZone: 'UTC',
    })
    .toUpperCase();
}

export function splitDayOffset(time: string | undefined): { clock: string; offset: string } {
  const m = /^(\d{1,2}:\d{2})(?:\s*\+(\d)d)?/.exec(time ?? '');
  return { clock: m?.[1] ?? '—', offset: m?.[2] ? `+${m[2]}` : '' };
}

export function MicroLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-[#6B7280]">{children}</div>
  );
}

interface BoardingPassProps {
  option: TransitOption;
  /** Position in the leg's ranking (0 = best Smart Score). */
  rank: number;
  isSelected: boolean;
  voucherCode?: string | null;
  /** The leg's departure date, used when the ticket does not carry its own. */
  departureDate?: string;
  onSelect: () => void;
  /** Source and score-flag chips, shown after the tags. */
  extras?: ReactNode;
  /** The booking button(s); receives the ticket's brand colours. Omit to show no button. */
  renderBook?: (accent: CSSProperties) => ReactNode;
}

/**
 * A flight ticket drawn as a boarding pass: a main body (barcode edge, flight details, route) and a
 * right-hand stub (baggage, price, booking) divided by a perforated tear line. On narrow screens the
 * stub moves below and the tear line turns horizontal. Header and accent strip use the operating
 * airline's brand colour, or a gradient of the airlines' colours for a multi-airline connection.
 */
export function BoardingPass({
  option,
  rank,
  isSelected,
  voucherCode,
  departureDate,
  onSelect,
  extras,
  renderBook,
}: BoardingPassProps) {
  const { fmt } = useCurrency();
  const airlines = useMemo(() => ticketAirlines(option), [option]);
  const palette = useMemo(() => ticketPalette(airlines), [airlines]);

  const hops = option.hops ?? [];
  const firstHop = hops[0];
  const lastHop = hops[hops.length - 1];
  const flights = (option.segments ?? []).filter((s) => s.mode === 'flight');
  const origin = firstHop?.fromCode ?? flights[0]?.fromCode ?? option.originStation.slice(-4, -1);
  const destination = lastHop?.toCode ?? flights[flights.length - 1]?.toCode ?? option.destinationStation.slice(-4, -1);
  const originName = firstHop?.fromName ?? flights[0]?.fromName ?? option.originStation;
  const destinationName = lastHop?.toName ?? flights[flights.length - 1]?.toName ?? option.destinationStation;

  const flightNumbers = hops.length
    ? hops.map((h) => h.flightNumber).filter(Boolean).join(' + ')
    : option.routeCode;
  const isReturn = option.ticketType === 'return';
  const date = ticketDate(option.departureAt ?? departureDate, false);
  const dep = splitDayOffset(option.departureTime);
  const arr = splitDayOffset(option.arrivalTime);
  const hubs = (option.layovers?.length ? option.layovers.map((l) => l.code) : [option.layoverHub ?? '']).filter(Boolean);
  const stops =
    option.stopsCount === 0 && option.layoverHours === 0
      ? 'DIRECT'
      : `${Math.max(option.stopsCount, 1)} STOP${option.stopsCount > 1 ? 'S' : ''} · ${formatDuration(
          option.layoverHours
        ).toUpperCase()}`;

  const bags = option.baggage ? describeBaggageStub(option.baggage) : null;
  const b = option.smartScoreBreakdown;
  const travelClass = (firstHop?.travelClass ?? 'Economy').toUpperCase();
  const accentButton: CSSProperties = { background: palette.background, color: palette.text };

  return (
    <div className="@container">
    <div
      data-option-id={option.id}
      data-source={option.dataSource ?? 'unknown'}
      data-route-code={option.routeCode}
      data-price={option.basePriceUsd}
      onClick={onSelect}
      className={`relative cursor-pointer overflow-hidden rounded-2xl bg-white shadow-sm transition-shadow hover:shadow-md ${
        isSelected ? 'ring-2 ring-[#FF812E]' : 'ring-1 ring-neutral-200'
      }`}
    >
      {/* Header bar: airline colour(s), spanning the main body and the stub */}
      <div
        className="grid @[28rem]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
        style={{ background: palette.background, color: palette.text }}
      >
        <div className="flex min-w-0 items-center justify-between gap-x-3 px-4 py-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Plane className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span
              className="text-[12px] font-extrabold uppercase leading-tight tracking-wide"
              title={airlines.map((a) => (a.code ? `${a.name} (${a.code})` : a.name)).join(' × ')}
            >
              {palette.label || option.carrier}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em]">
            {isSelected && (
              <span className="inline-flex items-center gap-1">
                <Check className="h-3 w-3" aria-hidden="true" />
                Selected
              </span>
            )}
            <span>{isReturn ? 'Return' : 'One-way'}</span>
          </div>
        </div>
        <div
          className="hidden min-w-0 items-center px-3 py-2 text-[9.5px] font-bold uppercase tracking-[0.1em] @[28rem]:flex"
          title={`Fare summary · ${travelClass}`}
        >
          <span className="truncate">
            Fare summary · {travelClass}
          </span>
        </div>
      </div>

      <div className="relative @[28rem]:grid @[28rem]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* Main body */}
        <div className="relative flex min-w-0">
          {/* Decorative barcode along the far-left edge */}
          <div className="w-5 shrink-0 border-r border-neutral-200 bg-neutral-50 p-1 text-[#111827]/80 @md:w-6">
            <Barcode seed={option.id} vertical className="h-full w-full" />
          </div>

          <button
            type="button"
            aria-pressed={isSelected}
            aria-label={`${palette.label || option.carrier} ${flightNumbers}, ${origin} to ${destination}`}
            className="relative flex min-w-0 flex-1 flex-col gap-2 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#FF812E]"
          >
            {/* Faint airplane watermark behind the route */}
            <Plane
              aria-hidden="true"
              className="pointer-events-none absolute right-6 top-1/2 h-36 w-36 -translate-y-1/2 -rotate-12 text-[#111827] opacity-[0.045]"
            />

            {/* Metadata row */}
            <div className="relative flex flex-wrap gap-x-4 gap-y-1">
              {hops.length <= 1 && (
                <div>
                  <MicroLabel>Flight</MicroLabel>
                  <div className="font-mono text-xs font-bold text-[#111827]">{flightNumbers || '—'}</div>
                </div>
              )}
              <div>
                <MicroLabel>Date</MicroLabel>
                <div className="font-mono text-xs font-bold text-[#111827]">
                  {date}
                  {isReturn && option.returnDate && (
                    <span className="font-semibold text-[#4B5563]"> · back {ticketDate(option.returnDate).slice(0, 6)}</span>
                  )}
                </div>
              </div>
              <div>
                <MicroLabel>Duration</MicroLabel>
                <div className="font-mono text-xs font-bold text-[#111827]">
                  {formatDuration(option.inVehicleHours + option.layoverHours).toUpperCase()}
                </div>
              </div>
              <div className="min-w-0 max-w-full">
                <MicroLabel>Stops</MicroLabel>
                <div
                  className={`font-mono text-xs font-bold ${
                    option.layoverHours > 4 ? 'text-[#B91C1C]' : 'text-[#111827]'
                  }`}
                  title={stops}
                >
                  {stops}
                </div>
              </div>
            </div>

            {/* Route hero */}
            <div className="relative grid grid-cols-[auto_minmax(1.5rem,1fr)_auto] items-center gap-2 @md:gap-3">
              <div className="min-w-0">
                <div className="font-display text-2xl font-black leading-none tracking-tight text-[#111827]">
                  {origin}
                </div>
                <div className="mt-0.5 font-mono text-sm font-bold text-[#111827]">{dep.clock}</div>
                <div className="max-w-[4.5rem] truncate text-[10px] text-[#4B5563] @md:max-w-[9rem]" title={originName}>
                  {originName}
                </div>
              </div>

              <div className="relative flex items-center self-start pt-2" aria-hidden="true">
                <div className="h-0 flex-1 border-t-2 border-dashed" style={{ borderColor: palette.accent }} />
                <Plane
                  className="mx-1 h-5 w-5 shrink-0 rotate-45"
                  style={{ color: palette.accent }}
                  fill="currentColor"
                />
                <div className="h-0 flex-1 border-t-2 border-dashed" style={{ borderColor: palette.accent }} />
                {hubs.length > 0 && option.stopsCount > 0 && (
                  <div className="absolute inset-x-0 top-[1.35rem] text-center font-mono text-[9px] font-bold uppercase tracking-wide text-[#4B5563]">
                    via {hubs.slice(0, 3).join(' · ')}
                  </div>
                )}
              </div>

              <div className="min-w-0 text-right">
                <div className="font-display text-2xl font-black leading-none tracking-tight text-[#111827]">
                  {destination}
                </div>
                <div className="mt-0.5 font-mono text-sm font-bold text-[#111827]">
                  {arr.clock}
                  {arr.offset && <sup className="ml-0.5 text-[9px] text-[#B45309]">{arr.offset}</sup>}
                </div>
                <div
                  className="ml-auto max-w-[4.5rem] truncate text-[10px] text-[#4B5563] @md:max-w-[9rem]"
                  title={destinationName}
                >
                  {destinationName}
                </div>
              </div>
            </div>

            {/* Flight-by-flight detail, only where there is more than one flight to explain */}
            {hops.length > 1 && (
              <div className="relative space-y-0.5 font-mono text-[10.5px] text-[#4B5563]">
                {hops.map((h, i) => (
                  <div key={`${h.flightNumber}-${i}`} className="whitespace-nowrap">
                    <span className="font-bold text-[#111827]">{h.flightNumber}</span>{' '}
                    {h.fromCode} {h.departureAt.slice(11, 16)} → {h.toCode} {h.arrivalAt.slice(11, 16)}
                  </div>
                ))}
              </div>
            )}

            {/* Tags: pinned to the bottom-left corner, beside the barcode edge */}
            <div className="relative mt-auto flex flex-wrap items-center gap-1.5">
              {rank === 0 && (
                <span className="text-[10px] font-bold uppercase tracking-wide text-[#E56B1A]">#1 Rank</span>
              )}
              {option.tags?.map((tag) => <TagPill key={tag} tag={tag} />)}
              {extras}
            </div>
          </button>
        </div>

        {/* Tear line (vertical on wide screens): the perforation; notches are on the ticket edges */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 left-[66%] top-0 hidden border-l-[1.5px] border-dashed border-neutral-300 @[28rem]:block"
        />

        {/* Stub */}
        <div className="relative border-t-[1.5px] border-dashed border-neutral-300 px-3 pb-2.5 pt-2 @[28rem]:flex @[28rem]:flex-col @[28rem]:gap-1.5 @[28rem]:border-t-0">
          {/* Tear line (horizontal on narrow screens) notches */}
          {(['left-0 -translate-x-1/2', 'right-0 translate-x-1/2'] as const).map((side) => (
            <span
              key={side}
              aria-hidden="true"
              className={`pointer-events-none absolute top-0 h-4 w-4 -translate-y-1/2 rounded-full bg-white ring-1 ring-neutral-200 @[28rem]:hidden ${side}`}
            />
          ))}

          <div className="mb-1 flex items-center justify-between @[28rem]:hidden">
            <MicroLabel>Fare summary</MicroLabel>
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#4B5563]">{travelClass}</span>
          </div>

          <div className="grid grid-cols-2 items-start gap-2 @[28rem]:flex @[28rem]:flex-col @[28rem]:gap-1.5">
            {/* Baggage */}
            <div className="min-w-0 space-y-1.5">
              <div className="@[28rem]:hidden"><MicroLabel>Baggage</MicroLabel></div>
              {bags ? (
                <div
                  className="space-y-1 text-[10.5px] font-medium leading-tight"
                  title={
                    option.baggage?.source === 'typical'
                      ? 'Typical economy allowance for this carrier; confirm it for your fare when booking.'
                      : 'Baggage as reported in the fare data'
                  }
                >
                  <div className={`flex items-center gap-1.5 ${TONE[bags.cabin.tone]}`}>
                    <Backpack className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {bags.cabin.text}
                  </div>
                  <div className={`flex items-center gap-1.5 ${TONE[bags.checked.tone]}`}>
                    <Luggage className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {bags.checked.text}
                  </div>
                </div>
              ) : (
                <div className="text-[11px] text-[#4B5563]">Not stated</div>
              )}
            </div>

            {/* Price */}
            <div className="text-right @[28rem]:text-left">
              <MicroLabel>{isReturn ? 'Return total' : 'Fare'} · per person</MicroLabel>
              <div className="mt-0.5 flex flex-wrap items-center justify-end gap-x-2 gap-y-1 @[28rem]:justify-start">
                {b.discountAppliedUsd > 0 && (
                  <span className="font-mono text-[11px] leading-none text-[#4B5563] line-through tabular-nums">
                    {fmt(option.basePriceUsd)}
                  </span>
                )}
                <span className="whitespace-nowrap font-display text-lg font-extrabold leading-none text-[#111827] tabular-nums">
                  {fmt(option.discountedPriceUsd)}
                </span>
                <SmartScoreBadge score={option.smartScore} size="sm" />
              </div>
              {voucherCode && b.discountAppliedUsd > 0 && (
                <div className="mt-0.5 font-mono text-[11px] font-medium text-[#16A34A] tabular-nums">
                  -{fmt(b.discountAppliedUsd)} · {voucherCode}
                </div>
              )}
            </div>
          </div>

          <div className="mt-2 space-y-1.5 @[28rem]:mt-auto">
            <Barcode seed={`${option.id}-stub`} className="h-3 w-full text-[#111827]/80 @[28rem]:hidden" />
            {renderBook && <div className="space-y-1.5">{renderBook(accentButton)}</div>}
          </div>
        </div>
      </div>

      {/* Bottom accent strip */}
      <div className="h-1.5" style={{ background: palette.background }} />

      {/* Punched semicircles where the tear line meets the top and bottom edges (wide screens) */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-[66%] top-0 hidden h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white ring-1 ring-neutral-200 @[28rem]:block"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 left-[66%] hidden h-4 w-4 -translate-x-1/2 translate-y-1/2 rounded-full bg-white ring-1 ring-neutral-200 @[28rem]:block"
      />
    </div>
    </div>
  );
}
