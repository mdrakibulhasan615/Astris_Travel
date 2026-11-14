import { useState } from 'react';
import {
  AlertTriangle,
  Bus,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Moon,
  Plane,
  Ship,
  TrainFront,
} from 'lucide-react';
import { formatDuration } from '../../shared/smartScore.ts';
import { isAffiliateUrl } from '../../shared/affiliate.ts';
import type {
  ModeFilter,
  ScoreFlag,
  TransitMode,
  TransitOption,
  TripLeg,
  Voucher,
} from '../../shared/types.ts';

interface LegTransitPanelProps {
  leg: TripLeg;
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

/** Outbound affiliate deep link; `sponsored` tells search engines it is a paid referral. */
function BookLink({ option }: { option: TransitOption }) {
  if (!option.bookingUrl) return null;
  return (
    <a
      href={option.bookingUrl}
      target="_blank"
      rel="sponsored noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-lg bg-[#FF812E] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#E56B1A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E] focus-visible:ring-offset-1"
      title={isAffiliateUrl(option.bookingUrl) ? 'Opens our booking partner' : 'Opens the booking site'}
    >
      Book {option.mode === 'flight' ? 'flight' : 'route'} · ${option.discountedPriceUsd.toFixed(0)}
      <ExternalLink className="w-3 h-3" aria-hidden="true" />
    </a>
  );
}

export function LegTransitPanel({
  leg,
  modeFilter,
  vouchers,
  isActive,
  onActivateLeg,
  onHoverLeg,
  onSelectOption,
}: LegTransitPanelProps) {
  const [expanded, setExpanded] = useState(leg.id === 'leg-ist-lon' || leg.id === 'leg-lon-par');

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
                    ${selectedOption.discountedPriceUsd.toFixed(0)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono text-[#E56B1A] font-medium">
                    Score: {selectedOption.smartScore.toFixed(0)}
                  </span>
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

        {selectedOption?.bookingUrl && !expanded && (
          <div className="flex justify-end px-3.5 pb-2.5">
            <BookLink option={selectedOption} />
          </div>
        )}

        {expanded && (
          <div className="px-3.5 pb-3.5 pt-1 border-t border-neutral-100 space-y-2">
            {filteredOptions.length === 0 ? (
              <div className="py-3 text-center text-xs text-[#4B5563]">
                No {modeFilter} options on {leg.fromCode} → {leg.toCode}.
              </div>
            ) : (
              filteredOptions.map((option, idx) => {
                const isSelected = option.id === selectedOption?.id;
                const voucherCode = getVoucherCode(option.appliedVoucherId);
                const { smartScoreBreakdown: b } = option;
                const hasLongLayover = option.layoverHours > 4;
                const hasNormalLayover = option.layoverHours >= 2 && option.layoverHours <= 4;

                return (
                  <div key={option.id}>
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
                          {option.isOvernightSleeper && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#4B5563]">
                              <Moon className="w-3 h-3 text-[#E56B1A]" />
                              0.4x Sleeper
                            </span>
                          )}
                        </div>

                        <div className="text-[11px] text-[#111827] font-mono tabular-nums">
                          {option.departureTime} → {option.arrivalTime}{' '}
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

                        {option.segments && option.segments.length > 0 && (
                          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] font-mono text-[#4B5563] tabular-nums">
                            {option.segments.map((seg, sIdx) => (
                              <span key={seg.id} className="inline-flex items-center gap-1">
                                <ModeIcon
                                  mode={seg.mode}
                                  className={`w-3 h-3 ${getModeAccentClass(seg.mode, false)}`}
                                />
                                <span>
                                  {seg.label} ({seg.durationMinutes}m)
                                </span>
                                {sIdx < option.segments!.length - 1 && (
                                  <span className="text-neutral-300">→</span>
                                )}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="text-right shrink-0 space-y-0.5">
                        <div className="flex items-center justify-end gap-1.5">
                          {b.discountAppliedUsd > 0 && (
                            <span className="font-mono text-[11px] text-[#4B5563] line-through tabular-nums">
                              ${option.basePriceUsd}
                            </span>
                          )}
                          <span className="font-display text-sm font-bold text-[#111827] tabular-nums">
                            ${option.discountedPriceUsd.toFixed(0)}
                          </span>
                        </div>

                        <div className="font-mono text-[11px] font-semibold text-[#E56B1A] tabular-nums">
                          Score: {option.smartScore.toFixed(0)}
                        </div>

                        {voucherCode && b.discountAppliedUsd > 0 && (
                          <div className="text-[11px] font-medium text-[#16A34A] font-mono tabular-nums">
                            -${b.discountAppliedUsd.toFixed(0)} · {voucherCode}
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
                    <FlagChips flags={b.flags} />
                    <BookLink option={option} />
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
