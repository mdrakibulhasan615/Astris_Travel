import type { TripLeg, TripStop } from './types.ts';

export const STOP_BADGE_PALETTE = [
  '#FF812E', // Selected / Primary Sunset Orange
  '#0D9488', // Teal
  '#7C3AED', // Purple
  '#D97706', // Amber
  '#0284C7', // Sky
  '#E11D48', // Rose
];

export function parseIsoUtc(isoDate: string): Date {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

export function formatIsoUtc(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDaysIso(isoDate: string, days: number): string {
  const dt = parseIsoUtc(isoDate);
  dt.setUTCDate(dt.getUTCDate() + days);
  return formatIsoUtc(dt);
}

export function diffDaysIso(startIso: string, endIso: string): number {
  const msPerDay = 86_400_000;
  return Math.round(
    (parseIsoUtc(endIso).getTime() - parseIsoUtc(startIso).getTime()) / msPerDay
  );
}

export function formatShortDate(isoDate: string): string {
  const dt = parseIsoUtc(isoDate);
  return dt.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * The first stop is where the trip starts: a departure point, not a stay. It has a single date
 * (`arrivalDate === departureDate`) and contributes no nights. Its `stayNights` is left untouched
 * and simply ignored, so dragging the stop to another position gives it its nights back.
 */
export function stopNights(stop: Pick<TripStop, 'stayNights'>, index: number): number {
  return index === 0 ? 0 : Math.max(1, stop.stayNights);
}

/** Nights actually spent across the trip (the origin contributes none). */
export function totalTripNights(stops: TripStop[]): number {
  return stops.reduce((sum, stop, index) => sum + stopNights(stop, index), 0);
}

export function formatTripDateSpan(stops: TripStop[]): string {
  if (stops.length === 0) return 'Select dates';
  const first = stops[0].arrivalDate;
  const last = stops[stops.length - 1].departureDate;
  const firstYear = parseIsoUtc(first).getUTCFullYear();
  const lastYear = parseIsoUtc(last).getUTCFullYear();
  if (firstYear === lastYear) {
    return `${formatShortDate(first)} – ${formatShortDate(last)}, ${lastYear}`;
  }
  return `${formatShortDate(first)} ${firstYear} – ${formatShortDate(last)} ${lastYear}`;
}

/**
 * Updates a single stop's arrival/departure/nights while clamping against the preceding
 * stop's departureDate (preventing overlaps) and sequentially cascading all subsequent stops.
 */
export function updateStopDatesAndCascade(
  stops: TripStop[],
  targetStopId: string,
  newArrivalDate: string,
  newDepartureDate: string
): TripStop[] {
  const targetIdx = stops.findIndex((s) => s.id === targetStopId);
  if (targetIdx === -1) return stops;

  const prevStop = targetIdx > 0 ? stops[targetIdx - 1] : null;
  const clampedArrival =
    prevStop && newArrivalDate < prevStop.departureDate
      ? prevStop.departureDate
      : newArrivalDate;

  // The origin only has a departure date; picking one must not invent a stay there
  const isOrigin = targetIdx === 0;
  const stayNights = isOrigin
    ? stops[targetIdx].stayNights
    : Math.max(1, diffDaysIso(clampedArrival, newDepartureDate));
  const resolvedDeparture = isOrigin ? clampedArrival : addDaysIso(clampedArrival, stayNights);

  const result = stops.map((s) => ({ ...s }));
  result[targetIdx] = {
    ...result[targetIdx],
    arrivalDate: clampedArrival,
    departureDate: resolvedDeparture,
    stayNights,
  };

  // Sequentially cascade all subsequent stops forward/backward so next.arrival >= prev.departure
  for (let i = targetIdx + 1; i < result.length; i++) {
    const prevOld = stops[i - 1];
    const curOld = stops[i];
    const originalGap = Math.max(0, diffDaysIso(prevOld.departureDate, curOld.arrivalDate));
    const prevNew = result[i - 1];
    const nextArrival = addDaysIso(prevNew.departureDate, originalGap);
    const nextNights = Math.max(1, curOld.stayNights);

    result[i] = {
      ...curOld,
      arrivalDate: nextArrival,
      departureDate: addDaysIso(nextArrival, nextNights),
      stayNights: nextNights,
    };
  }

  return result;
}

/**
 * Updates stayNights for one stop (+/- nights) and cascades subsequent stops' dates.
 */
export function updateStopNightsAndCascade(
  stops: TripStop[],
  targetStopId: string,
  deltaNights: number
): TripStop[] {
  const targetIdx = stops.findIndex((s) => s.id === targetStopId);
  // The origin has no nights to change
  if (targetIdx <= 0) return stops;
  const target = stops[targetIdx];
  const nextNights = Math.max(1, target.stayNights + deltaNights);
  const nextDeparture = addDaysIso(target.arrivalDate, nextNights);
  return updateStopDatesAndCascade(stops, targetStopId, target.arrivalDate, nextDeparture);
}

/**
 * Recalculates sequential arrival/departure dates across all stops after drag-and-drop
 * reordering, anchoring on the earliest trip start date and preserving each stop's stayNights.
 * Whichever stop ends up first becomes the origin and collapses to a single departure date.
 */
export function recalculateDatesAfterReorder(
  reorderedStops: TripStop[],
  legs?: TripLeg[]
): TripStop[] {
  if (reorderedStops.length === 0) return reorderedStops;

  // Anchor trip start date to the earliest existing arrival date so trip stays in its planned window
  const anchorStart = reorderedStops.reduce(
    (minDate, s) => (s.arrivalDate < minDate ? s.arrivalDate : minDate),
    reorderedStops[0].arrivalDate
  );

  let cursorDate = anchorStart;
  return reorderedStops.map((stop, idx) => {
    if (idx > 0 && legs && legs[idx - 1]) {
      const leg = legs[idx - 1];
      const selected =
        leg.transitOptions.find((o) => o.id === leg.selectedOptionId) ??
        leg.transitOptions[0];
      // Add +1 calendar day when crossing long-haul overnight corridors (>= 9h)
      if (selected && selected.inVehicleHours + selected.layoverHours >= 9) {
        cursorDate = addDaysIso(cursorDate, 1);
      }
    }

    const nights = stopNights(stop, idx);
    const arrivalDate = cursorDate;
    const departureDate = addDaysIso(arrivalDate, nights);
    cursorDate = departureDate;

    return {
      ...stop,
      order: idx + 1,
      arrivalDate,
      departureDate,
    };
  });
}

/**
 * Permanently assigns each stop a fixed color from STOP_BADGE_PALETTE
 * based on its sequence index (Stop 1 = #FF812E, Stop 2 = #0D9488, Stop 3 = #7C3AED, Stop 4 = #D97706)
 * so colors never swap when selecting different stops.
 */
export function getStopColorMap(stops: TripStop[]): Record<string, string> {
  const map: Record<string, string> = {};
  stops.forEach((stop, idx) => {
    map[stop.id] = STOP_BADGE_PALETTE[idx % STOP_BADGE_PALETTE.length];
  });
  return map;
}
