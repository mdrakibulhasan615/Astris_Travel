import { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight, X } from 'lucide-react';
import {
  addDaysIso,
  diffDaysIso,
  formatIsoUtc,
  formatShortDate,
  getStopColorMap,
  parseIsoUtc,
} from '../../shared/dateUtils.ts';
import type { TripStop } from '../../shared/types.ts';

interface MultiDestDatePickerModalProps {
  isOpen: boolean;
  stops: TripStop[];
  initialStopId: string | null;
  onClose: () => void;
  onUpdateStopDates: (stopId: string, arrivalDate: string, departureDate: string) => void;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function getMonthGrid(year: number, monthZeroBased: number): Array<{ iso: string; inMonth: boolean }> {
  const firstOfMonth = new Date(Date.UTC(year, monthZeroBased, 1));
  // Convert Sunday=0..Saturday=6 to Monday=0..Sunday=6
  const startDayOfWeek = (firstOfMonth.getUTCDay() + 6) % 7;
  const gridStart = new Date(Date.UTC(year, monthZeroBased, 1 - startDayOfWeek));

  const cells: Array<{ iso: string; inMonth: boolean }> = [];
  for (let i = 0; i < 42; i++) {
    const dt = new Date(gridStart.getTime() + i * 86_400_000);
    cells.push({
      iso: formatIsoUtc(dt),
      inMonth: dt.getUTCMonth() === monthZeroBased,
    });
  }
  return cells;
}

export function MultiDestDatePickerModal({
  isOpen,
  stops,
  initialStopId,
  onClose,
  onUpdateStopDates,
}: MultiDestDatePickerModalProps) {
  const [selectedStopId, setSelectedStopId] = useState<string>(
    initialStopId ?? stops[0]?.id ?? ''
  );
  const [draftStartIso, setDraftStartIso] = useState<string | null>(null);
  const [hoverIso, setHoverIso] = useState<string | null>(null);

  const activeStop =
    stops.find((s) => s.id === selectedStopId) ?? stops[0] ?? null;

  const [viewMonth, setViewMonth] = useState<{ year: number; month: number }>(() => {
    const seed = activeStop?.arrivalDate ?? '2026-11-18';
    const dt = parseIsoUtc(seed);
    return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() };
  });

  const stopsRef = useRef(stops);
  stopsRef.current = stops;

  // Sync active stop & visible month only when modal opens or initialStopId changes
  useEffect(() => {
    if (!isOpen) return;
    const currentStops = stopsRef.current;
    const targetId = initialStopId ?? currentStops[0]?.id ?? '';
    setSelectedStopId(targetId);
    setDraftStartIso(null);
    setHoverIso(null);
    const targetStop = currentStops.find((s) => s.id === targetId) ?? currentStops[0];
    if (targetStop) {
      const dt = parseIsoUtc(targetStop.arrivalDate);
      setViewMonth({ year: dt.getUTCFullYear(), month: dt.getUTCMonth() });
    }
  }, [isOpen, initialStopId]);

  const stopColorMap = useMemo(() => getStopColorMap(stops), [stops]);
  const activeColor = activeStop
    ? (stopColorMap[activeStop.id] ?? '#FF812E')
    : '#FF812E';

  const activeStopIndex = activeStop
    ? stops.findIndex((s) => s.id === activeStop.id)
    : -1;
  const prevStopMinArrival =
    activeStopIndex > 0 ? stops[activeStopIndex - 1].departureDate : null;

  const tripStartIso = stops[0]?.arrivalDate ?? null;
  const tripEndIso = stops[stops.length - 1]?.departureDate ?? null;
  const firstStopColor = stops[0] ? (stopColorMap[stops[0].id] ?? '#FF812E') : '#FF812E';
  const lastStopColor =
    stops[stops.length - 1]
      ? (stopColorMap[stops[stops.length - 1].id] ?? '#D97706')
      : '#FF812E';

  // Map every calendar date inside [tripStartIso, tripEndIso] to either:
  // - a regular stay night (soft tinted rectangle), or
  // - a handoff/transition day (diagonal split-color rectangle between outgoing & incoming stops).
  const { stayDayMap, handoffDayMap, bridgeDaySet } = useMemo(() => {
    const stayMap: Record<string, { stop: TripStop; color: string }> = {};
    const handoffMap: Record<
      string,
      { outStop: TripStop; inStop: TripStop; outColor: string; inColor: string }
    > = {};
    const bridgeSet = new Set<string>();

    for (let idx = 0; idx < stops.length; idx++) {
      const stop = stops[idx];
      const color = stopColorMap[stop.id] ?? '#FF812E';
      const nights = Math.max(1, diffDaysIso(stop.arrivalDate, stop.departureDate));

      for (let n = 0; n < nights; n++) {
        const iso = addDaysIso(stop.arrivalDate, n);
        // Never overwrite tripStartIso or an earlier stop's night
        if (!stayMap[iso]) {
          stayMap[iso] = { stop, color };
        }
      }

      // Transition / handoff day between stop[idx] and stop[idx + 1]
      if (idx < stops.length - 1) {
        const nextStop = stops[idx + 1];
        const nextColor = stopColorMap[nextStop.id] ?? '#0D9488';
        const depIso = stop.departureDate;

        handoffMap[depIso] = {
          outStop: stop,
          inStop: nextStop,
          outColor: color,
          inColor: nextColor,
        };

        // Fill any multi-day transit gap strictly between depIso and nextStop.arrivalDate
        const gapDays = diffDaysIso(depIso, nextStop.arrivalDate);
        for (let g = 1; g < gapDays; g++) {
          bridgeSet.add(addDaysIso(depIso, g));
        }
      }
    }

    return { stayDayMap: stayMap, handoffDayMap: handoffMap, bridgeDaySet: bridgeSet };
  }, [stops, stopColorMap]);

  if (!isOpen || stops.length === 0) return null;

  const monthTitle = new Date(Date.UTC(viewMonth.year, viewMonth.month, 1)).toLocaleDateString(
    'en-US',
    { month: 'long', year: 'numeric', timeZone: 'UTC' }
  );

  const monthCells = getMonthGrid(viewMonth.year, viewMonth.month);

  const shiftMonth = (delta: number) => {
    const dt = new Date(Date.UTC(viewMonth.year, viewMonth.month + delta, 1));
    setViewMonth({ year: dt.getUTCFullYear(), month: dt.getUTCMonth() });
  };

  const handleSelectStopTab = (stop: TripStop) => {
    setSelectedStopId(stop.id);
    setDraftStartIso(null);
    setHoverIso(null);
    const dt = parseIsoUtc(stop.arrivalDate);
    setViewMonth({ year: dt.getUTCFullYear(), month: dt.getUTCMonth() });
  };

  const handleDayClick = (iso: string) => {
    if (!activeStop) return;
    if (prevStopMinArrival && iso < prevStopMinArrival) return;

    if (!draftStartIso) {
      // First click begins range selection for the active stop
      setDraftStartIso(iso);
      return;
    }

    if (iso <= draftStartIso) {
      // Clicked same or earlier day: treat as 1-night stay starting on clicked date if same, else restart range
      if (iso === draftStartIso) {
        onUpdateStopDates(activeStop.id, iso, addDaysIso(iso, 1));
        setDraftStartIso(null);
        setHoverIso(null);
      } else {
        setDraftStartIso(iso);
      }
      return;
    }

    // Second click sets departureDate (arrivalDate -> iso) and cascades subsequent stops
    onUpdateStopDates(activeStop.id, draftStartIso, iso);
    setDraftStartIso(null);
    setHoverIso(null);
  };

  // Preview range while selecting second date
  const previewEndIso =
    draftStartIso && hoverIso && hoverIso > draftStartIso ? hoverIso : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Multi-destination trip date picker"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/25 backdrop-blur-xs"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg bg-white border border-slate-200/80 shadow-xl rounded-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span
              className="w-8 h-8 rounded-xl border flex items-center justify-center transition-colors shrink-0"
              style={{
                backgroundColor: `${activeColor}14`,
                borderColor: `${activeColor}45`,
                color: activeColor,
              }}
            >
              <Calendar className="w-4 h-4" />
            </span>
            <div>
              <h2 className="font-display text-base font-bold text-[#111827]">
                Itinerary Dates
              </h2>
              {activeStop && (
                <div className="text-xs font-mono text-[#4B5563] tabular-nums">
                  {activeStop.city}: {formatShortDate(activeStop.arrivalDate)} →{' '}
                  {formatShortDate(activeStop.departureDate)} ({activeStop.stayNights}n)
                </div>
              )}
            </div>
          </div>

          <button
            type="button"
            aria-label="Close calendar"
            onClick={onClose}
            className="w-8 h-8 rounded-xl flex items-center justify-center text-[#4B5563] hover:text-[#111827] hover:bg-slate-100 transition-colors cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Active Stop Selector Tabs (wrapping cleanly without horizontal clipping) */}
        <div className="px-5 pt-3.5 pb-2 flex flex-wrap items-center gap-2">
          {stops.map((stop, idx) => {
            const isSelected = stop.id === activeStop?.id;
            const color = stopColorMap[stop.id] ?? '#FF812E';
            return (
              <button
                key={stop.id}
                type="button"
                onClick={() => handleSelectStopTab(stop)}
                style={
                  isSelected
                    ? {
                        borderColor: color,
                        backgroundColor: `${color}14`,
                      }
                    : undefined
                }
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs whitespace-nowrap shrink-0 border transition-all cursor-pointer ${
                  isSelected
                    ? 'font-bold text-[#111827] shadow-xs'
                    : 'font-medium bg-white border-slate-200/80 text-[#4B5563] hover:text-[#111827] hover:border-slate-300'
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: color }}
                />
                <span>
                  {idx + 1}. {stop.city}
                </span>
                <span className="font-mono text-[11px] text-[#4B5563] tabular-nums">
                  {stop.stayNights}n
                </span>
              </button>
            );
          })}
        </div>

        {/* Calendar Month Navigation & Grid */}
        <div className="px-5 py-3 space-y-3">
          <div className="flex items-center justify-between">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => shiftMonth(-1)}
              className="w-8 h-8 rounded-xl border border-slate-200/80 flex items-center justify-center text-[#4B5563] hover:text-[#111827] hover:bg-slate-50 transition-colors cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            <h3 className="font-display text-sm font-bold text-[#111827]">
              {monthTitle}
            </h3>

            <button
              type="button"
              aria-label="Next month"
              onClick={() => shiftMonth(1)}
              className="w-8 h-8 rounded-xl border border-slate-200/80 flex items-center justify-center text-[#4B5563] hover:text-[#111827] hover:bg-slate-50 transition-colors cursor-pointer"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Weekday Headers */}
          <div className="grid grid-cols-7 text-center">
            {WEEKDAYS.map((day) => (
              <div
                key={day}
                className="text-[11px] font-medium text-[#4B5563] py-1"
              >
                {day}
              </div>
            ))}
          </div>

          {/* 42-Day Calendar Matrix (Continuous Seamless Ribbon) */}
          <div className="grid grid-cols-7 gap-x-0 gap-y-1.5">
            {monthCells.map(({ iso, inMonth }) => {
              const dayNum = Number(iso.slice(-2));
              const stay = stayDayMap[iso];
              const handoff = handoffDayMap[iso];
              const isBridge = bridgeDaySet.has(iso);
              const isTripStart = tripStartIso !== null && iso === tripStartIso;
              const isTripEnd = tripEndIso !== null && iso === tripEndIso;
              const isBeforePrevStop =
                prevStopMinArrival !== null && iso < prevStopMinArrival;

              const isDraftStart = draftStartIso === iso;
              const isInDraftPreview =
                draftStartIso !== null &&
                previewEndIso !== null &&
                iso > draftStartIso &&
                iso < previewEndIso;
              const isDraftEnd = previewEndIso === iso;
              const isAnyDraft = isDraftStart || isInDraftPreview || isDraftEnd;

              let bgStyle: string | undefined;
              let bgImageStyle: string | undefined;
              let textColor = inMonth ? '#111827' : '#9CA3AF';
              let radiusClass = 'rounded-none';
              let boxShadowStyle: string | undefined;
              let fontWeightClass = 'font-medium';

              const isSelectingRange = draftStartIso !== null;

              if (isAnyDraft && isSelectingRange) {
                if (isDraftStart) {
                  // Pending start date: temporary rounded left pill cap in active stop's solid color
                  bgStyle = activeColor;
                  textColor = '#FFFFFF';
                  fontWeightClass = 'font-bold';
                  radiusClass = 'rounded-l-full rounded-r-none';
                } else if (isDraftEnd) {
                  // Prospective hovered end date: temporary rounded right pill cap in active stop's solid color
                  bgStyle = activeColor;
                  textColor = '#FFFFFF';
                  fontWeightClass = 'font-bold';
                  radiusClass = 'rounded-r-full rounded-l-none';
                } else {
                  // Intermediate hovered nights: flat sharp-cornered soft-tinted rectangles
                  bgStyle = `${activeColor}26`;
                  textColor = '#111827';
                  fontWeightClass = 'font-semibold';
                  radiusClass = 'rounded-none';
                  boxShadowStyle = `inset 0 2px 0 0 ${activeColor}, inset 0 -2px 0 0 ${activeColor}`;
                }
              } else if (isTripStart) {
                // Trip Start Date ONLY: solid pill cap rounded only on the left
                bgStyle = firstStopColor;
                textColor = '#FFFFFF';
                fontWeightClass = 'font-bold';
                radiusClass = 'rounded-l-full rounded-r-none';
              } else if (isTripEnd) {
                // Trip End Date ONLY: solid pill cap rounded only on the right
                bgStyle = lastStopColor;
                textColor = '#FFFFFF';
                fontWeightClass = 'font-bold';
                radiusClass = 'rounded-r-full rounded-l-none';
              } else if (handoff) {
                // Handoff/Transition Day: flat rectangle split diagonally between outgoing and incoming colors
                bgImageStyle = `linear-gradient(135deg, ${handoff.outColor} 49%, ${handoff.inColor} 51%)`;
                textColor = '#FFFFFF';
                fontWeightClass = 'font-semibold';
                radiusClass = 'rounded-none';
              } else if (stay) {
                // Intermediate Night: flat sharp-cornered rectangle with soft tinted background & dark text
                const isActiveStopDay = stay.stop.id === activeStop?.id;
                bgStyle = isActiveStopDay ? `${stay.color}26` : `${stay.color}16`;
                textColor = '#111827';
                fontWeightClass = isActiveStopDay ? 'font-semibold' : 'font-medium';
                radiusClass = 'rounded-none';
                if (isActiveStopDay) {
                  boxShadowStyle = `inset 0 2px 0 0 ${stay.color}, inset 0 -2px 0 0 ${stay.color}`;
                }
              } else if (isBridge) {
                bgStyle = '#F1F5F9';
                textColor = '#475569';
                radiusClass = 'rounded-none';
              }

              const tooltipText =
                isBeforePrevStop && prevStopMinArrival
                  ? `Available from ${formatShortDate(prevStopMinArrival)}`
                  : handoff
                    ? `${handoff.outStop.city} → ${handoff.inStop.city} (${iso})`
                    : isTripEnd && stops[stops.length - 1]
                      ? `${stops[stops.length - 1].city} departure (${iso})`
                      : stay
                        ? `${stay.stop.city} (${stay.stop.arrivalDate} → ${stay.stop.departureDate})`
                        : iso;

              return (
                <button
                  key={iso}
                  type="button"
                  disabled={isBeforePrevStop}
                  onMouseEnter={() => {
                    if (draftStartIso && !isBeforePrevStop) setHoverIso(iso);
                  }}
                  onClick={() => handleDayClick(iso)}
                  title={tooltipText}
                  style={{
                    backgroundColor: bgStyle,
                    backgroundImage: bgImageStyle,
                    color: textColor,
                    boxShadow: boxShadowStyle,
                  }}
                  className={`relative h-9 flex items-center justify-center font-mono text-xs tabular-nums transition-colors ${
                    isBeforePrevStop ? 'cursor-not-allowed' : 'cursor-pointer'
                  } ${fontWeightClass} ${radiusClass} ${
                    !bgStyle && !bgImageStyle && !isBeforePrevStop
                      ? 'hover:bg-slate-100 rounded-md'
                      : ''
                  }`}
                >
                  {dayNum}
                </button>
              );
            })}
          </div>

          {/* Selection status telemetry */}
          <div className="flex items-center justify-between text-[11px] font-mono text-[#4B5563] pt-1 tabular-nums">
            <span>
              {draftStartIso
                ? previewEndIso
                  ? `${formatShortDate(draftStartIso)} → ${formatShortDate(
                      previewEndIso
                    )} (${diffDaysIso(draftStartIso, previewEndIso)}n)`
                  : `Check-in ${formatShortDate(draftStartIso)} · Pick check-out`
                : activeStop
                  ? `${activeStop.city} · ${formatShortDate(activeStop.arrivalDate)} → ${formatShortDate(activeStop.departureDate)}`
                  : ''}
            </span>
            {draftStartIso && (
              <button
                type="button"
                onClick={() => {
                  setDraftStartIso(null);
                  setHoverIso(null);
                }}
                style={{ color: activeColor }}
                className="font-semibold hover:underline cursor-pointer"
              >
                Cancel
              </button>
            )}
          </div>
        </div>

        {/* Horizontal Color-Dot City Legend & Done Action */}
        <div className="px-5 py-3.5 bg-[#FAFAFA] border-t border-slate-100 flex items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            {stops.map((stop) => {
              const color = stopColorMap[stop.id] ?? '#FF812E';
              const isSelected = stop.id === activeStop?.id;
              return (
                <button
                  key={stop.id}
                  type="button"
                  onClick={() => handleSelectStopTab(stop)}
                  style={
                    isSelected
                      ? {
                          borderColor: color,
                          backgroundColor: `${color}12`,
                        }
                      : undefined
                  }
                  className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-xs transition-all cursor-pointer whitespace-nowrap ${
                    isSelected
                      ? 'font-bold text-[#111827]'
                      : 'border-transparent font-medium text-[#4B5563] hover:text-[#111827] hover:bg-white'
                  }`}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: color }}
                  />
                  <span>{stop.city}</span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-xl bg-[#FF812E] hover:bg-[#E56B1A] text-white text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
