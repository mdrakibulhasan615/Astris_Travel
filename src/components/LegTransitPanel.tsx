import { useState, type CSSProperties } from 'react';
import {
  AlertTriangle,
  Bus,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Backpack,
  Luggage,
  Moon,
  Plane,
  Ship,
  Sparkles,
  TrainFront,
} from 'lucide-react';
import { formatShortDate } from '../../shared/dateUtils.ts';
import { describeBaggage } from '../../shared/ticketDetails.ts';
import { useCurrency } from '../currency.tsx';
import { formatDuration } from '../../shared/smartScore.ts';
import { PROVIDER_NAMES } from '../../shared/affiliate.ts';
import { BoardingPass, TagPill } from './BoardingPass.tsx';
import { SmartScoreBadge } from './SmartScoreBadge.tsx';
import type {
  BaggageInfo,
  ModeFilter,
  ScoreFlag,
  TicketType,
  TransitMode,
  TransitOption,
  TripLeg,
  Voucher,
} from '../../shared/types.ts';

export interface TicketChange {
  type?: TicketType;
  returnDate?: string;
  /** Hand the choice back to the cheapest-fare automation. */
  auto?: boolean;
}

interface LegTransitPanelProps {
  leg: TripLeg;
  /** The later leg that comes back; a return ticket on this leg would cover it. */
  pairedLeg?: TripLeg;
  /** The leg whose return ticket already covers this one. */
  coveredByLeg?: TripLeg;
  onChangeTicket: (legId: string, change: TicketChange) => void;
  modeFilter: ModeFilter;
  vouchers: Voucher[];
  isActive: boolean;
  onActivateLeg: (legId: string) => void;
  onHoverLeg: (legId: string | null) => void;
  onSelectOption: (legId: string, optionId: string) => void;
}

function ModeIcon({ mode, className }: { mode: TransitMode; className?: string }) {
  if (mode === 'flight') return <Plane className={className} />;
  if (mode === 'train') return <TrainFront className={className} />;
  if (mode === 'ferry') return <Ship className={className} />;
  return <Bus className={className} />;
}

function getModeAccentClass(mode: TransitMode, isSelected: boolean): string {
  if (mode === 'flight') return isSelected ? 'text-[#FF812E]' : 'text-[#FF812E]';
  if (mode === 'train') return 'text-[#0D9488]';
  if (mode === 'bus') return 'text-[#7C3AED]';
  return 'text-[#0284C7]';
}

const FLAG_LABELS: Record<ScoreFlag, string> = {
  'red-eye': 'Red-eye departure',
  'early-departure': 'Early departure',
  'late-arrival': 'Late-night arrival',
  'long-layover': 'Long layover',
  'overnight-layover': 'Overnight layover',
  'multi-stop': 'Multi-stop',
  'airport-change': 'Airport change',
};

/** Warning-level flags are highlighted; informational ones stay neutral. */
const WARNING_FLAGS: ReadonlySet<ScoreFlag> = new Set([
  'red-eye',
  'overnight-layover',
  'airport-change',
  'late-arrival',
]);

/**
 * Tells the user whether the ticket details are a real provider fare or sample/estimated data.
 * Sample data (curated or synthesized) must never look like a live fare.
 */
function SourceChip({ source }: { source: TransitOption['dataSource'] }) {
  if (source === 'live') {
    return (
      <span
        title="Real fare from the flight search provider"
        className="rounded-md bg-[#F0FDF4] px-1.5 py-0.5 text-[10px] font-medium text-[#15803D]"
      >
        Live fare
      </span>
    );
  }
  return (
    <span
      title={
        source === 'curated'
          ? 'Hand-authored sample itinerary; times, flight number and price are illustrative'
          : 'Estimated itinerary generated from distance; not a real timetable'
      }
      className="rounded-md bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-[#4B5563]"
    >
      {source === 'synthesized' ? 'Estimate' : 'Sample'}
    </span>
  );
}

function FlagChips({ flags }: { flags: ScoreFlag[] }) {
  if (flags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {flags.map((flag) => (
        <span
          key={flag}
          className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
            WARNING_FLAGS.has(flag)
              ? 'bg-[#FEF2F2] text-[#B91C1C]'
              : 'bg-neutral-100 text-[#4B5563]'
          }`}
        >
          {FLAG_LABELS[flag]}
        </span>
      ))}
    </div>
  );
}

/**
 * Direct link to the merchant's results for this exact option (route, airports, date, travellers,
 * and the airline for real fares). `sponsored` tells search engines it is a paid referral.
 */
function BookLink({
  option,
  url = option.bookingUrl,
  label,
  secondary = false,
  accent,
}: {
  option: TransitOption;
  url?: string;
  label?: string;
  secondary?: boolean;
  /** Brand colours (boarding pass): overrides the default orange button and fills the stub width. */
  accent?: CSSProperties;
}) {
  const { fmt } = useCurrency();
  if (!url) return null;
  const merchant = option.bookingProvider ? PROVIDER_NAMES[option.bookingProvider] : 'partner site';
  // Only a live fare has a price worth repeating on the button; estimates are a search, not a quote
  const isLive = option.dataSource === 'live';
  const kind = option.ticketType === 'return' ? 'return ' : '';
  const text =
    label ??
    (isLive
      ? `Book ${kind}on ${merchant} · ${fmt(option.discountedPriceUsd)}`
      : `Find ${kind}on ${merchant}`);
  return (
    <a
      href={url}
      target="_blank"
      rel="sponsored noopener noreferrer"
      onClick={() => {
        // Development aid: the exact URL the browser is about to open
        if (import.meta.env.DEV) console.debug('[Booking] opening', option.id, url);
      }}
      style={secondary ? undefined : accent}
      className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E] focus-visible:ring-offset-1 ${
        accent ? 'w-full justify-center py-1.5 hover:brightness-95' : ''
      } ${
        secondary
          ? 'border border-neutral-200 bg-white text-[#111827] hover:border-[#FFD6BA] hover:bg-[#FFF4ED]'
          : accent
            ? ''
            : 'bg-[#FF812E] text-white hover:bg-[#E56B1A]'
      }`}
      title={`Opens ${merchant} with this route, date and travellers filled in`}
    >
      {text}
      <ExternalLink className="w-3 h-3" aria-hidden="true" />
    </a>
  );
}

/** Ground return tickets are sold per direction, so they get one button each way. */
function BookLinks({ option, accent }: { option: TransitOption; accent?: CSSProperties }) {
  if (!option.bookingUrl) return null;
  if (option.ticketType === 'return' && option.returnBookingUrl) {
    const merchant = option.bookingProvider ? PROVIDER_NAMES[option.bookingProvider] : 'partner site';
    return (
      <div className={accent ? 'space-y-1.5' : 'flex flex-wrap items-center gap-1.5'}>
        <BookLink option={option} label={`Outbound on ${merchant}`} accent={accent} />
        <BookLink
          option={option}
          url={option.returnBookingUrl}
          label={`Way back on ${merchant}`}
          secondary
          accent={accent}
        />
      </div>
    );
  }
  return <BookLink option={option} accent={accent} />;
}

const legLabel = (l: TripLeg) => `${l.fromCode} → ${l.toCode}`;

const BAG_TONE = { good: 'text-[#15803D]', warn: 'text-[#B45309]', muted: 'text-[#4B5563]' } as const;

/** Carry-on and checked baggage for the ticket (from the fare data, or the carrier's typical policy). */
function BaggageLine({ baggage }: { baggage: BaggageInfo }) {
  const d = describeBaggage(baggage);
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]"
      title={
        baggage.source === 'typical'
          ? `Typical economy allowance for this carrier; confirm it for your fare when booking.${
              baggage.note ? ` ${baggage.note}.` : ''
            }`
          : 'Baggage as reported in the fare data'
      }
    >
      <span className={`inline-flex items-center gap-1 ${BAG_TONE[d.cabin.tone]}`}>
        <Backpack className="h-3 w-3" aria-hidden="true" />
        {d.cabin.text}
      </span>
      <span className={`inline-flex items-center gap-1 ${BAG_TONE[d.checked.tone]}`}>
        <Luggage className="h-3 w-3" aria-hidden="true" />
        {d.checked.text}
      </span>
      {baggage.source === 'typical' && <span className="text-[10px] text-[#4B5563]">typical</span>}
    </div>
  );
}

/**
 * One-way / return selector for the leg, the one-way-vs-return price comparison when the trip
 * comes back to where this leg started, and the "already covered" notice for the way back.
 */
function TicketControls({
  leg,
  pairedLeg,
  coveredByLeg,
  onChangeTicket,
}: {
  leg: TripLeg;
  pairedLeg?: TripLeg;
  coveredByLeg?: TripLeg;
  onChangeTicket: (legId: string, change: TicketChange) => void;
}) {
  const { fmt } = useCurrency();
  if (leg.transitOptions.length === 0 && !leg.oneWayOptions?.length) return null;

  if (coveredByLeg) {
    return (
      <div className="mx-3.5 mb-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#FFD6BA] bg-[#FFF4ED] px-3 py-2 text-[11px] text-[#111827]">
        <span>
          <span className="font-semibold">Covered by your return ticket</span> on{' '}
          {legLabel(coveredByLeg)}. Nothing to book for this leg.
        </span>
        <button
          type="button"
          onClick={() => onChangeTicket(coveredByLeg.id, { type: 'one-way' })}
          className="rounded-lg border border-neutral-200 bg-white px-2 py-1 font-semibold hover:border-[#FFD6BA] cursor-pointer"
        >
          Book one-way tickets instead
        </button>
      </div>
    );
  }

  const type: TicketType = leg.ticketType ?? 'one-way';
  const cmp = leg.fareComparison;
  const isLiveComparison = cmp?.basis === 'live';
  const chosenIsCheapest = !cmp || cmp.cheaper === 'tie' || cmp.cheaper === type;

  return (
    <div className="px-3.5 pb-2.5 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div
          role="radiogroup"
          aria-label={`Ticket type for ${legLabel(leg)}`}
          className="inline-flex rounded-lg bg-neutral-100 p-0.5"
        >
          {(['one-way', 'return'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={type === t}
              onClick={() => onChangeTicket(leg.id, { type: t })}
              className={`rounded-md px-2.5 py-1 text-[11px] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E] ${
                type === t
                  ? 'bg-white font-bold text-[#111827] shadow-xs'
                  : 'font-medium text-[#4B5563] hover:text-[#111827]'
              }`}
            >
              {t === 'one-way' ? 'One-way' : 'Return'}
            </button>
          ))}
        </div>

        {type === 'return' &&
          (pairedLeg ? (
            <span className="text-[11px] text-[#4B5563] tabular-nums">
              Back {leg.returnDate ? formatShortDate(leg.returnDate) : ''} · covers{' '}
              <span className="font-medium text-[#111827]">{legLabel(pairedLeg)}</span>
            </span>
          ) : (
            <label className="inline-flex items-center gap-1.5 text-[11px] text-[#4B5563]">
              Return on
              <input
                type="date"
                value={leg.returnDate ?? ''}
                min={leg.departureDate}
                onChange={(e) => e.target.value && onChangeTicket(leg.id, { returnDate: e.target.value })}
                className="rounded-md border border-neutral-200 bg-white px-1.5 py-0.5 font-mono text-[11px] text-[#111827] focus:outline-none focus:ring-2 focus:ring-[#FF812E]"
              />
            </label>
          ))}

        {leg.ticketLocked && (
          <button
            type="button"
            onClick={() => onChangeTicket(leg.id, { auto: true })}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-[#4B5563] hover:text-[#111827] cursor-pointer"
          >
            <Sparkles className="h-3 w-3 text-[#FF812E]" aria-hidden="true" />
            Pick the cheapest for me
          </button>
        )}
      </div>

      {pairedLeg && cmp && (
        <div
          className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-[11px] ${
            isLiveComparison && chosenIsCheapest
              ? 'border-[#FFD6BA] bg-[#FFF4ED]'
              : 'border-neutral-200 bg-neutral-50'
          }`}
        >
          {isLiveComparison ? (
            <>
              <div className="space-y-0.5">
                <div className="font-semibold text-[#111827]">
                  {cmp.cheaper === 'tie'
                    ? 'Return and two one-ways cost the same'
                    : cmp.cheaper === 'return'
                      ? `Return ticket is ${fmt(cmp.savingsUsd)} cheaper`
                      : `Two one-way tickets are ${fmt(cmp.savingsUsd)} cheaper`}
                </div>
                <div className="font-mono text-[#4B5563] tabular-nums">
                  Return {fmt(cmp.returnTotalUsd)} · One-way {legLabel(leg)} + {legLabel(pairedLeg)}{' '}
                  {fmt(cmp.oneWayTotalUsd)}
                </div>
              </div>
              {chosenIsCheapest ? (
                <span className="inline-flex items-center gap-1 font-semibold text-[#E56B1A]">
                  <Check className="h-3 w-3" aria-hidden="true" />
                  {leg.ticketLocked ? 'Your choice' : 'Selected automatically'}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onChangeTicket(leg.id, { type: cmp.cheaper as TicketType })}
                  className="rounded-lg bg-[#FF812E] px-2.5 py-1 font-semibold text-white hover:bg-[#E56B1A] cursor-pointer"
                >
                  Switch to {cmp.cheaper === 'return' ? 'return' : 'one-way'} · save{' '}
                  {fmt(cmp.savingsUsd)}
                </button>
              )}
            </>
          ) : (
            <span className="text-[#4B5563]">
              Return vs two one-ways ({legLabel(pairedLeg)}): compared once live fares are available.
              Estimates are not used to pick a ticket.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function LegTransitPanel({
  leg,
  pairedLeg,
  coveredByLeg,
  onChangeTicket,
  modeFilter,
  vouchers,
  isActive,
  onActivateLeg,
  onHoverLeg,
  onSelectOption,
}: LegTransitPanelProps) {
  const [expanded, setExpanded] = useState(leg.id === 'leg-ist-lon' || leg.id === 'leg-lon-par');
  const { fmt } = useCurrency();

  const filteredOptions =
    modeFilter === 'all'
      ? leg.transitOptions
      : leg.transitOptions.filter((opt) => opt.mode === modeFilter);

  const selectedOption =
    leg.transitOptions.find((o) => o.id === leg.selectedOptionId) ??
    leg.transitOptions[0];

  const getVoucherCode = (voucherId?: string | null) => {
    if (!voucherId) return null;
    return vouchers.find((v) => v.id === voucherId)?.code ?? null;
  };

  return (
    <div
      onMouseEnter={() => onHoverLeg(leg.id)}
      onMouseLeave={() => onHoverLeg(null)}
      className="relative pl-6 my-1.5"
    >
      <div
        aria-hidden="true"
        className={`absolute left-[15px] top-0 bottom-0 w-0.5 transition-colors ${
          isActive ? 'bg-[#FF812E]' : 'bg-neutral-200'
        }`}
      />

      <div
        className={`rounded-2xl bg-white border transition-all ${
          isActive
            ? 'border-[#FFD6BA] shadow-md'
            : 'border-neutral-200/80 shadow-sm hover:shadow-md'
        }`}
      >
        <button
          type="button"
          onClick={() => {
            onActivateLeg(leg.id);
            setExpanded((prev) => !prev);
          }}
          className="w-full px-4 py-2.5 flex items-center justify-between gap-3 text-left cursor-pointer rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E]"
        >
          <div className="min-w-0 flex items-center gap-3">
            <span
              className={`w-7 h-7 rounded-xl flex items-center justify-center shrink-0 ${
                isActive ? 'bg-[#FFF4ED]' : 'bg-neutral-100'
              }`}
            >
              {selectedOption ? (
                <ModeIcon
                  mode={selectedOption.mode}
                  className={`w-3.5 h-3.5 ${getModeAccentClass(selectedOption.mode, isActive)}`}
                />
              ) : (
                <Plane className="w-3.5 h-3.5 text-[#FF812E]" />
              )}
            </span>

            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 text-xs font-semibold text-[#111827]">
                <span>
                  {leg.fromCode} → {leg.toCode}
                </span>
                <span className="font-mono text-[#4B5563] font-normal tabular-nums">
                  {leg.distanceKm.toLocaleString()} km
                </span>
                {selectedOption && (
                  <>
                    <span className="text-neutral-300" aria-hidden="true">
                      ·
                    </span>
                    <span className="font-medium text-[#4B5563] truncate">
                      {selectedOption.carrier}
                    </span>
                    <span className="font-mono font-normal text-[#4B5563]">
                      {selectedOption.routeCode}
                    </span>
                    {leg.ticketType === 'return' && (
                      <span className="rounded-md border border-[#FFD6BA] bg-[#FFF4ED] px-1.5 py-px text-[10px] font-semibold text-[#E56B1A]">
                        Return
                      </span>
                    )}
                  </>
                )}
              </div>

              {selectedOption && (
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-[#4B5563] tabular-nums">
                  <span>
                    {formatDuration(selectedOption.inVehicleHours + selectedOption.layoverHours)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {selectedOption.stopsCount === 0
                      ? 'Direct'
                      : `${selectedOption.stopsCount} stop (${formatDuration(
                          selectedOption.layoverHours
                        )})`}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono font-semibold text-[#111827]">
                    {fmt(selectedOption.discountedPriceUsd)}
                  </span>
                  <SmartScoreBadge score={selectedOption.smartScore} size="sm" />
                </div>
              )}

              {!selectedOption && leg.transitOptions.length === 0 && (
                <div className="mt-0.5 text-[11px] text-[#4B5563]">
                  Same city as the previous stop · no transport needed
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0 text-xs font-medium text-[#4B5563]">
            <span className="font-mono tabular-nums">{filteredOptions.length}</span>
            {expanded ? (
              <ChevronUp className="w-4 h-4 text-[#4B5563]" />
            ) : (
              <ChevronDown className="w-4 h-4 text-[#4B5563]" />
            )}
          </div>
        </button>

        <TicketControls
          leg={leg}
          pairedLeg={pairedLeg}
          coveredByLeg={coveredByLeg}
          onChangeTicket={onChangeTicket}
        />

        {selectedOption?.bookingUrl && !expanded && !coveredByLeg && (
          <div className="flex justify-end px-3.5 pb-2.5">
            <BookLinks option={selectedOption} />
          </div>
        )}

        {expanded && (
          <div className="px-3.5 pb-3.5 pt-1 border-t border-neutral-100 space-y-2">
            {filteredOptions.length === 0 ? (
              <div className="py-3 text-center text-xs text-[#4B5563]">
                {leg.transitOptions.length === 0
                  ? `You are already in ${leg.toCity}: these two stops are the same place.`
                  : `No ${modeFilter} options on ${leg.fromCode} → ${leg.toCode}.`}
              </div>
            ) : (
              filteredOptions.map((option, idx) => {
                const isSelected = option.id === selectedOption?.id;
                const voucherCode = getVoucherCode(option.appliedVoucherId);
                const { smartScoreBreakdown: b } = option;
                const hasLongLayover = option.layoverHours > 4;
                const hasNormalLayover = option.layoverHours >= 2 && option.layoverHours <= 4;

                // Flights are drawn as boarding passes; trains, coaches and ferries keep the compact card
                if (option.mode === 'flight') {
                  return (
                    <BoardingPass
                      key={option.id}
                      option={option}
                      rank={idx}
                      isSelected={isSelected}
                      voucherCode={voucherCode}
                      departureDate={leg.departureDate}
                      onSelect={() => {
                        onActivateLeg(leg.id);
                        onSelectOption(leg.id, option.id);
                      }}
                      extras={
                        <>
                          <SourceChip source={option.dataSource} />
                          <FlagChips flags={b.flags} />
                        </>
                      }
                      renderBook={
                        coveredByLeg
                          ? undefined
                          : (accent) => <BookLinks option={option} accent={accent} />
                      }
                    />
                  );
                }

                return (
                  <div
                    key={option.id}
                    data-option-id={option.id}
                    data-source={option.dataSource ?? 'unknown'}
                    data-route-code={option.routeCode}
                    data-price={option.basePriceUsd}
                  >
                  <button
                    type="button"
                    onClick={() => {
                      onActivateLeg(leg.id);
                      onSelectOption(leg.id, option.id);
                    }}
                    className={`w-full text-left rounded-xl p-3 border transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E] ${
                      isSelected
                        ? 'bg-[#FFF4ED] border-[#FFD6BA]'
                        : 'bg-white border-neutral-200/80 hover:border-neutral-300'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-x-2">
                          <ModeIcon
                            mode={option.mode}
                            className={`w-3.5 h-3.5 shrink-0 ${getModeAccentClass(
                              option.mode,
                              isSelected
                            )}`}
                          />
                          <span className="font-semibold text-xs text-[#111827]">
                            {option.carrier}
                          </span>
                          <span className="font-mono text-[11px] text-[#4B5563]">
                            {option.routeCode}
                          </span>
                          {idx === 0 && (
                            <span className="text-[11px] font-semibold text-[#E56B1A]">
                              · #1 Rank
                            </span>
                          )}
                          {option.tags?.map((tag) => <TagPill key={tag} tag={tag} />)}
                          {option.ticketType === 'return' && option.returnDate && (
                            <span className="rounded-md border border-[#FFD6BA] bg-[#FFF4ED] px-1.5 py-px text-[10px] font-semibold text-[#E56B1A]">
                              Return · back {formatShortDate(option.returnDate)}
                            </span>
                          )}
                          {option.isOvernightSleeper && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#4B5563]">
                              <Moon className="w-3 h-3 text-[#E56B1A]" />
                              0.4x Sleeper
                            </span>
                          )}
                        </div>

                        <div className="text-[11px] text-[#111827] font-mono tabular-nums">
                          {(option.departureAt?.slice(0, 10) || leg.departureDate) && (
                            <span className="font-sans text-[#4B5563]">
                              {formatShortDate(
                                (option.departureAt?.slice(0, 10) || leg.departureDate)!
                              )}{' '}
                            </span>
                          )}
                          {option.departureTime || '—'} → {option.arrivalTime || '—'}{' '}
                          <span className="font-sans text-[#4B5563]">
                            · {option.originStation} → {option.destinationStation}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-[#4B5563] tabular-nums">
                          <span>Travel {formatDuration(option.inVehicleHours)}</span>
                          <span aria-hidden="true">·</span>
                          {option.layoverHours > 0 ? (
                            <span
                              className={`inline-flex items-center gap-1 ${
                                hasLongLayover
                                  ? 'text-[#DC2626] font-medium'
                                  : hasNormalLayover
                                    ? 'text-[#D97706] font-medium'
                                    : ''
                              }`}
                            >
                              {hasLongLayover && <AlertTriangle className="w-3 h-3" />}
                              {formatDuration(option.layoverHours)} @ {option.layoverHub || 'Hub'}{' '}
                              ({b.layoverMultiplier}x)
                            </span>
                          ) : (
                            <span>Direct</span>
                          )}
                          <span aria-hidden="true">·</span>
                          <span>{option.co2Kg} kg CO₂</span>
                        </div>

                        {option.hops && option.hops.length > 0 && (
                          <div className="space-y-0.5">
                            {option.hops.map((hop, hIdx) => (
                              <div key={`${hop.flightNumber}-${hIdx}`}>
                                <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] font-mono text-[#4B5563] tabular-nums">
                                  {hop.airlineLogo && (
                                    <img
                                      src={hop.airlineLogo}
                                      alt=""
                                      loading="lazy"
                                      referrerPolicy="no-referrer"
                                      className="h-3.5 w-3.5 rounded-sm object-contain"
                                    />
                                  )}
                                  <span className="font-semibold text-[#111827]">
                                    {hop.flightNumber || hop.airline}
                                  </span>
                                  <span>
                                    {hop.fromCode} {hop.departureAt.slice(11, 16)} → {hop.toCode}{' '}
                                    {hop.arrivalAt.slice(11, 16)}
                                  </span>
                                  <span>{formatDuration(hop.durationMinutes / 60)}</span>
                                  {hop.airplane && (
                                    <span className="font-sans">· {hop.airplane}</span>
                                  )}
                                </div>
                                {option.layovers?.[hIdx] && (
                                  <div className="pl-5 text-[11px] text-[#D97706] tabular-nums">
                                    Layover {formatDuration(option.layovers[hIdx].minutes / 60)} in{' '}
                                    {option.layovers[hIdx].code}
                                    {option.layovers[hIdx].overnight ? ' · overnight' : ''}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}

                        {option.baggage && <BaggageLine baggage={option.baggage} />}
                      </div>

                      <div className="text-right shrink-0 space-y-0.5">
                        <div className="flex items-center justify-end gap-1.5">
                          {b.discountAppliedUsd > 0 && (
                            <span className="font-mono text-[11px] text-[#4B5563] line-through tabular-nums">
                              {fmt(option.basePriceUsd)}
                            </span>
                          )}
                          <span className="font-display text-sm font-bold text-[#111827] tabular-nums">
                            {fmt(option.discountedPriceUsd)}
                          </span>
                        </div>

                        <div className="text-[10px] text-[#4B5563]">
                          {option.ticketType === 'return' ? 'return total' : 'one-way'} · per person
                        </div>

                        <div>
                          <SmartScoreBadge score={option.smartScore} />
                        </div>

                        {voucherCode && b.discountAppliedUsd > 0 && (
                          <div className="text-[11px] font-medium text-[#16A34A] font-mono tabular-nums">
                            -{fmt(b.discountAppliedUsd)} · {voucherCode}
                          </div>
                        )}

                        {isSelected && (
                          <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#E56B1A]">
                            <Check className="w-3 h-3" />
                            <span>Selected</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                  <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 px-1">
                    <div className="flex flex-wrap items-center gap-1">
                      <SourceChip source={option.dataSource} />
                      <FlagChips flags={b.flags} />
                    </div>
                    {!coveredByLeg && <BookLinks option={option} />}
                  </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
