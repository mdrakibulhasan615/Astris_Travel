import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { Backpack, Bus, Check, Luggage, TrainFront } from 'lucide-react';
import { formatDuration } from '../../shared/smartScore.ts';
import { describeBaggageStub } from '../../shared/ticketDetails.ts';
import type { TransitOption } from '../../shared/types.ts';
import { useCurrency } from '../currency.tsx';
import { SmartScoreBadge } from './SmartScoreBadge.tsx';
import {
  Barcode,
  MicroLabel,
  TagPill,
  TONE,
  seededRandom,
  splitDayOffset,
  ticketDate,
} from './BoardingPass.tsx';

/** Accent colours: every coach ticket is lime, every train ticket is purple. */
export const BUS_ACCENT = '#abed00';
export const TRAIN_ACCENT = '#5600D6';
const BUS_INK = '#1f3300';
const BUS_EDGE = '#4a6e00';

interface GroundTicketProps {
  option: TransitOption;
  rank: number;
  isSelected: boolean;
  voucherCode?: string | null;
  departureDate?: string;
  /** Leg endpoints (city codes), shown large on the ticket; station names go underneath. */
  fromCode: string;
  toCode: string;
  onSelect: () => void;
  extras?: ReactNode;
  renderBook?: (accent: CSSProperties) => ReactNode;
}

/** Shared facts both tickets print. */
function useTicketFacts(option: TransitOption, departureDate?: string) {
  const dep = splitDayOffset(option.departureTime);
  const arr = splitDayOffset(option.arrivalTime);
  const direct = option.stopsCount === 0 && option.layoverHours === 0;
  const changes = Math.max(option.stopsCount, 1);
  const stops = direct
    ? 'DIRECT'
    : `${changes} CHANGE${changes > 1 ? 'S' : ''} · ${formatDuration(option.layoverHours).toUpperCase()}${
        option.layoverHub ? ` AT ${option.layoverHub.toUpperCase()}` : ''
      }`;
  const number = useMemo(() => {
    const rand = seededRandom(`${option.id}-no`);
    return Array.from({ length: 11 }, () => Math.floor(rand() * 10)).join('');
  }, [option.id]);
  return {
    dep,
    arr,
    stops,
    number,
    date: ticketDate(option.departureAt ?? departureDate, false),
    isReturn: option.ticketType === 'return',
    duration: formatDuration(option.inVehicleHours + option.layoverHours).toUpperCase(),
    bags: option.baggage ? describeBaggageStub(option.baggage) : null,
  };
}

function BagLines({ option, className = '', note = true, inline = false }: { option: TransitOption; className?: string; note?: boolean; inline?: boolean }) {
  const bags = option.baggage ? describeBaggageStub(option.baggage) : null;
  if (!bags) return null;
  return (
    <div className={`text-[10.5px] font-medium leading-tight ${inline ? 'flex flex-wrap gap-x-3 gap-y-0.5' : 'space-y-0.5'} ${className}`}>
      <div className={`flex items-center gap-1.5 ${TONE[bags.cabin.tone]}`}>
        <Backpack className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {bags.cabin.text}
      </div>
      <div className={`flex items-center gap-1.5 ${TONE[bags.checked.tone]}`}>
        <Luggage className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {bags.checked.text}
      </div>
      {note && option.baggage?.note && <div className="text-[10px] font-normal text-[#4B5563]">{option.baggage.note}</div>}
    </div>
  );
}

// ── Bus ──────────────────────────────────────────────────────────────────────────────────────

/** A column of semicircle cut-outs along a ticket edge (the scalloped border of a paper bus ticket). */
function Scallops({ side }: { side: 'left' | 'right' }) {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-y-0 flex flex-col justify-around py-1 ${
        side === 'left' ? '-left-2' : '-right-2'
      }`}
    >
      {Array.from({ length: 7 }, (_, i) => (
        <span key={i} className="h-4 w-4 rounded-full bg-white" />
      ))}
    </div>
  );
}

function BusTicket({
  option,
  rank,
  isSelected,
  voucherCode,
  departureDate,
  fromCode,
  toCode,
  onSelect,
  extras,
  renderBook,
}: GroundTicketProps) {
  const { fmt } = useCurrency();
  const f = useTicketFacts(option, departureDate);
  const b = option.smartScoreBreakdown;
  const panel = `color-mix(in srgb, ${BUS_ACCENT} 55%, white)`;

  return (
    <div className="@container">
      <div
        data-option-id={option.id}
        data-source={option.dataSource ?? 'unknown'}
        data-route-code={option.routeCode}
        data-price={option.basePriceUsd}
        data-ticket="bus"
        onClick={onSelect}
        style={{ background: BUS_ACCENT, color: BUS_INK }}
        className={`relative cursor-pointer overflow-hidden rounded-2xl px-6 py-1.5 shadow-sm transition-shadow hover:shadow-md ${
          isSelected ? 'ring-2 ring-[#FF812E]' : 'ring-1 ring-neutral-200'
        }`}
      >
        <Scallops side="left" />
        <Scallops side="right" />
        {/* Dotted perforation just inside each scalloped edge */}
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-3 left-3.5 border-l-2 border-dotted border-white/80" />
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-3 right-3.5 border-r-2 border-dotted border-white/80" />

        <div
          className="flex gap-2.5 rounded-xl border-2 px-2.5 py-1.5"
          style={{ background: panel, borderColor: BUS_EDGE }}
        >
          <div className="grid min-w-0 flex-1 gap-2 @[28rem]:grid-cols-[minmax(0,1fr)_8.5rem] @[28rem]:gap-2.5">
            <div className="flex min-w-0 flex-col gap-1">
            {/* Title row */}
            <div className="flex min-w-0 items-center gap-2">
              <Bus className="h-7 w-7 shrink-0" style={{ color: BUS_EDGE }} fill={BUS_ACCENT} aria-hidden="true" />
              <div className="min-w-0">
                <div className="whitespace-nowrap font-display text-base font-black uppercase leading-none tracking-tight">Bus ticket</div>
                <div className="mt-0.5 truncate text-[10.5px] font-bold uppercase leading-tight tracking-wide" title={option.carrier}>
                  {option.carrier}
                </div>
              </div>
              <div className="ml-auto shrink-0 font-mono text-[10px] font-semibold tracking-[0.12em]">{f.number}</div>
            </div>

            {/* Route */}
            <div className="grid grid-cols-[auto_minmax(1.5rem,1fr)_auto] items-center gap-2">
              <div className="min-w-0">
                <div className="font-display text-xl font-black leading-none">{fromCode}</div>
                <div className="mt-0.5 font-mono text-sm font-bold">{f.dep.clock}</div>
                <div className="max-w-[5rem] truncate text-[10px] @md:max-w-[9rem]" title={option.originStation}>
                  {option.originStation}
                </div>
              </div>
              <div className="flex items-center self-start pt-2" aria-hidden="true">
                <div className="h-0 flex-1 border-t-2 border-dashed" style={{ borderColor: BUS_EDGE }} />
                <Bus className="mx-1 h-4 w-4 shrink-0" style={{ color: BUS_EDGE }} />
                <div className="h-0 flex-1 border-t-2 border-dashed" style={{ borderColor: BUS_EDGE }} />
              </div>
              <div className="min-w-0 text-right">
                <div className="font-display text-xl font-black leading-none">{toCode}</div>
                <div className="mt-0.5 font-mono text-sm font-bold">
                  {f.arr.clock}
                  {f.arr.offset && <sup className="ml-0.5 text-[9px]">{f.arr.offset}</sup>}
                </div>
                <div className="ml-auto max-w-[5rem] truncate text-[10px] @md:max-w-[9rem]" title={option.destinationStation}>
                  {option.destinationStation}
                </div>
              </div>
            </div>

            {/* Details */}
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              <div>
                <MicroLabel>Date</MicroLabel>
                <div className="font-mono text-xs font-bold">
                  {f.date}
                  {f.isReturn && option.returnDate && (
                    <span className="font-semibold"> · back {ticketDate(option.returnDate).slice(0, 6)}</span>
                  )}
                </div>
              </div>
              <div>
                <MicroLabel>Duration</MicroLabel>
                <div className="font-mono text-xs font-bold">{f.duration}</div>
              </div>
              <div className="min-w-0">
                <MicroLabel>Stops</MicroLabel>
                <div className="font-mono text-xs font-bold" title={f.stops}>
                  {f.stops}
                </div>
              </div>
            </div>

            {/* Tags */}
              <div className="flex flex-wrap items-center gap-1.5">
                {rank === 0 && <span className="text-[10px] font-bold uppercase tracking-wide text-[#9A3412]">#1 Rank</span>}
                {option.tags?.map((tag) => <TagPill key={tag} tag={tag} />)}
                {option.isOvernightSleeper && (
                  <span className="rounded-full bg-white/70 px-2 py-px text-[10px] font-semibold">Overnight</span>
                )}
                {extras}
              </div>

            </div>

            {/* Stub: baggage, fare, booking */}
            <div
              className="flex min-w-0 flex-col gap-1.5 border-t-2 border-dashed pt-2 @[28rem]:border-l-2 @[28rem]:border-t-0 @[28rem]:pl-3 @[28rem]:pt-0"
              style={{ borderColor: BUS_EDGE }}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-bold uppercase tracking-[0.12em]">
                {isSelected && (
                  <span className="inline-flex items-center gap-1">
                    <Check className="h-3 w-3" aria-hidden="true" />
                    Selected
                  </span>
                )}
                <span>{f.isReturn ? 'Return' : 'One-way'}</span>
                {extras}
              </div>
              <BagLines option={option} note={false} />
              <div className="mt-auto">
                <MicroLabel>{f.isReturn ? 'Return total' : 'Fare'} · per person</MicroLabel>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="whitespace-nowrap font-display text-lg font-extrabold leading-none tabular-nums">
                    {fmt(option.discountedPriceUsd)}
                  </span>
                  {b.discountAppliedUsd > 0 && (
                    <span className="font-mono text-[11px] leading-none line-through tabular-nums">{fmt(option.basePriceUsd)}</span>
                  )}
                </div>
                {voucherCode && b.discountAppliedUsd > 0 && (
                  <div className="font-mono text-[11px] font-semibold text-[#166534] tabular-nums">
                    -{fmt(b.discountAppliedUsd)} · {voucherCode}
                  </div>
                )}
                <div className="mt-1">
                  <SmartScoreBadge score={option.smartScore} size="sm" />
                </div>
              </div>
              {renderBook && (
                <div className="space-y-1.5">{renderBook({ background: BUS_INK, color: BUS_ACCENT })}</div>
              )}
            </div>
          </div>

          {/* Barcode column on the right, like the paper ticket */}
          <div className="w-6 shrink-0 border-l-2 border-dashed pl-2.5 @md:w-8" style={{ borderColor: BUS_EDGE, color: BUS_EDGE }}>
            <Barcode seed={option.id} vertical className="h-full w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Train ────────────────────────────────────────────────────────────────────────────────────

function TrainTicket({
  option,
  rank,
  isSelected,
  voucherCode,
  departureDate,
  fromCode,
  toCode,
  onSelect,
  extras,
  renderBook,
}: GroundTicketProps) {
  const { fmt } = useCurrency();
  const f = useTicketFacts(option, departureDate);
  const b = option.smartScoreBreakdown;
  const watermark = useMemo(() => `${option.carrier.toUpperCase()} · `.repeat(160), [option.carrier]);
  const mono = 'font-mono';

  return (
    <div className="@container">
      <div
        data-option-id={option.id}
        data-source={option.dataSource ?? 'unknown'}
        data-route-code={option.routeCode}
        data-price={option.basePriceUsd}
        data-ticket="train"
        onClick={onSelect}
        className={`relative cursor-pointer overflow-hidden rounded-2xl bg-[#FBFAF2] shadow-sm transition-shadow hover:shadow-md ${
          isSelected ? 'ring-2 ring-[#FF812E]' : 'ring-1 ring-neutral-200'
        }`}
      >
        {/* Header band */}
        <div
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-4 py-1.5 text-white"
          style={{ background: TRAIN_ACCENT }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <TrainFront className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className={`${mono} text-[12px] font-bold uppercase leading-tight tracking-wide`}>
              {option.carrier} · Train ticket
            </span>
          </div>
          <div className={`${mono} flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide`}>
            {isSelected && (
              <span className="inline-flex items-center gap-1">
                <Check className="h-3 w-3" aria-hidden="true" />
                Selected
              </span>
            )}
            <span>{f.isReturn ? 'Return' : 'Outward'}</span>
          </div>
        </div>

        {/* Body: printed like a rail ticket, with the operator name faintly repeated behind */}
        <div className={`relative px-4 py-2 ${mono} text-[#111827]`}>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 overflow-hidden break-all text-[8px] font-bold leading-[1.15] tracking-widest opacity-[0.07]"
            style={{ color: TRAIN_ACCENT }}
          >
            {watermark}
          </div>

          <div className="relative space-y-1.5">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
              <div className="text-[11px] font-semibold">
                Valid for {f.isReturn ? 'outward and return journeys' : 'one journey'}
                <span className="ml-2 tracking-[0.12em] text-[#4B5563]">No. {f.number}</span>
              </div>
              <div className="text-right">
                <div className="text-sm font-bold">
                  {f.date}
                  {f.isReturn && option.returnDate && (
                    <span className="text-[11px] font-semibold text-[#4B5563]"> · back {ticketDate(option.returnDate).slice(0, 6)}</span>
                  )}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-[auto_minmax(1.5rem,1fr)_auto] items-center gap-2">
              <div className="min-w-0">
                                <div className="font-display text-xl font-black leading-none">{fromCode}</div>
                <div className="text-sm font-bold">{f.dep.clock}</div>
                <div className="max-w-[5rem] truncate font-sans text-[10px] text-[#4B5563] @md:max-w-[9rem]" title={option.originStation}>
                  {option.originStation}
                </div>
              </div>
              <div className="flex items-center self-center pt-3" aria-hidden="true">
                <div className="h-0 flex-1 border-t-2 border-dashed" style={{ borderColor: TRAIN_ACCENT }} />
                <TrainFront className="mx-1 h-4 w-4 shrink-0" style={{ color: TRAIN_ACCENT }} />
                <div className="h-0 flex-1 border-t-2 border-dashed" style={{ borderColor: TRAIN_ACCENT }} />
              </div>
              <div className="min-w-0 text-right">
                                <div className="font-display text-xl font-black leading-none">{toCode}</div>
                <div className="text-sm font-bold">
                  {f.arr.clock}
                  {f.arr.offset && <sup className="ml-0.5 text-[9px] text-[#B45309]">{f.arr.offset}</sup>}
                </div>
                <div className="ml-auto max-w-[5rem] truncate font-sans text-[10px] text-[#4B5563] @md:max-w-[9rem]" title={option.destinationStation}>
                  {option.destinationStation}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <div>
                <MicroLabel>Duration</MicroLabel>
                <div className="text-xs font-bold">{f.duration}</div>
              </div>
              <div className="min-w-0">
                <MicroLabel>Changes</MicroLabel>
                <div className="text-xs font-bold" title={f.stops}>
                  {f.stops}
                </div>
              </div>
              {option.routeCode && (
                <div>
                  <MicroLabel>Service</MicroLabel>
                  <div className="text-xs font-bold">{option.routeCode}</div>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 font-sans">
              <BagLines option={option} note={false} inline />
              <div className="flex flex-wrap items-center gap-1.5">
              {rank === 0 && <span className="text-[10px] font-bold uppercase tracking-wide text-[#E56B1A]">#1 Rank</span>}
              {option.tags?.map((tag) => <TagPill key={tag} tag={tag} />)}
              {option.isOvernightSleeper && (
                <span className="rounded-full bg-neutral-100 px-2 py-px text-[10px] font-semibold text-[#374151]">Sleeper</span>
              )}
              {extras}
                <SmartScoreBadge score={option.smartScore} size="sm" />
              </div>
            </div>
          </div>
        </div>

        {/* Fare band, torn off from the body by a perforation with side notches */}
        <div className="relative text-white" style={{ background: TRAIN_ACCENT }}>
          {(['left-0 -translate-x-1/2', 'right-0 translate-x-1/2'] as const).map((side) => (
            <span
              key={side}
              aria-hidden="true"
              className={`pointer-events-none absolute top-0 h-4 w-4 -translate-y-1/2 rounded-full bg-white ring-1 ring-neutral-200 ${side}`}
            />
          ))}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2">
            <span
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white"
              style={{ color: TRAIN_ACCENT }}
            >
              <TrainFront className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className={`${mono} text-[9px] font-semibold uppercase tracking-[0.14em] text-white/80`}>
                {f.isReturn ? 'Return total' : 'Fare'} · per person
              </div>
              <div className="flex items-baseline gap-2">
                <span className="whitespace-nowrap font-display text-lg font-extrabold leading-tight tabular-nums">
                  {fmt(option.discountedPriceUsd)}
                </span>
                {b.discountAppliedUsd > 0 && (
                  <span className={`${mono} text-[11px] leading-none text-white/80 line-through tabular-nums`}>
                    {fmt(option.basePriceUsd)}
                  </span>
                )}
              </div>
              {voucherCode && b.discountAppliedUsd > 0 && (
                <div className={`${mono} text-[11px] font-semibold text-[#BBF7D0] tabular-nums`}>
                  -{fmt(b.discountAppliedUsd)} · {voucherCode}
                </div>
              )}
            </div>
            {renderBook && (
              <div className="ml-auto w-full min-w-[10rem] space-y-1.5 @md:w-44">{renderBook({ background: '#FFFFFF', color: TRAIN_ACCENT })}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Coach tickets (lime) and rail tickets (purple); other modes keep the compact card. */
export function GroundTicket(props: GroundTicketProps) {
  return props.option.mode === 'train' ? <TrainTicket {...props} /> : <BusTicket {...props} />;
}
