import type { TransitOption, TripLeg } from '../shared/types.ts';

/**
 * Development-only helpers for checking that what is on screen matches what the API returned.
 * All functions are no-ops in production builds.
 *
 * Compare three places for the same option id:
 *   1. server terminal:   `[Flight Data] default-trip leg-kul-ist selected=... | TK 61 | 23:05 → ...`
 *   2. browser console:   `[Flights] ...` table below
 *   3. the card itself:   inspect the element, `data-option-id` / `data-route-code` / `data-price`
 */

/** Fields that make up the ticket the user sees. They must survive the pipeline unchanged. */
const TICKET_FIELDS = [
  'id',
  'carrier',
  'carrierCode',
  'routeCode',
  'departureTime',
  'arrivalTime',
  'inVehicleHours',
  'layoverHours',
  'stopsCount',
  'basePriceUsd',
  'dataSource',
] as const satisfies readonly (keyof TransitOption)[];

function selectedOf(leg: TripLeg): TransitOption | undefined {
  return leg.transitOptions.find((o) => o.id === leg.selectedOptionId) ?? leg.transitOptions[0];
}

/** Logs a table of the selected option per leg as it enters React state. */
export function logFlightState(label: string, legs: TripLeg[]): void {
  if (!import.meta.env.DEV) return;
  const rows = legs.map((leg) => {
    const o = selectedOf(leg);
    return {
      leg: leg.id,
      options: leg.transitOptions.length,
      live: leg.transitOptions.filter((x) => x.dataSource === 'live').length,
      selected: o?.id,
      source: o?.dataSource ?? '?',
      carrier: o?.carrier,
      flight: o?.routeCode,
      depart: o?.departureTime,
      arrive: o?.arrivalTime,
      travelH: o?.inVehicleHours,
      layoverH: o?.layoverHours,
      priceUsd: o?.basePriceUsd,
    };
  });
  console.groupCollapsed(`[Flights] ${label}: ${legs.length} legs → state`);
  console.table(rows);
  console.groupEnd();
}

/**
 * Compares the raw API response with the legs actually placed into state and warns about any
 * ticket field that differs. Catches accidental transforms between `fetch` and `setState`.
 */
export function verifyLegsMatchResponse(label: string, raw: TripLeg[], inState: TripLeg[]): void {
  if (!import.meta.env.DEV) return;
  const diffs: string[] = [];
  if (raw.length !== inState.length) {
    diffs.push(`leg count ${raw.length} (response) vs ${inState.length} (state)`);
  }
  raw.forEach((rawLeg, i) => {
    const stateLeg = inState[i];
    if (!stateLeg || stateLeg.id !== rawLeg.id) {
      diffs.push(`leg[${i}] id ${rawLeg.id} vs ${stateLeg?.id}`);
      return;
    }
    for (const rawOpt of rawLeg.transitOptions) {
      const stateOpt = stateLeg.transitOptions.find((o) => o.id === rawOpt.id);
      if (!stateOpt) {
        diffs.push(`${rawLeg.id}: option ${rawOpt.id} missing from state`);
        continue;
      }
      for (const field of TICKET_FIELDS) {
        if (rawOpt[field] !== stateOpt[field]) {
          diffs.push(`${rawOpt.id}.${field}: response=${String(rawOpt[field])} state=${String(stateOpt[field])}`);
        }
      }
    }
  });
  if (diffs.length > 0) {
    console.error(`[Flights] ${label}: state does NOT match API response`, diffs);
  } else {
    console.debug(`[Flights] ${label}: state matches API response (${raw.length} legs)`);
  }
}
