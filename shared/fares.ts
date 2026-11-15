import { toMetroCode } from './airports.ts';
import type {
  FareComparison,
  LegTicketPref,
  TicketType,
  TransitOption,
  TripLeg,
  TripStop,
} from './types.ts';

/**
 * Fare structures. A leg A → B can be bought as one-way, or as a return ticket (A → B → A). In a
 * multi-stop trip a later leg often comes back (KUL → IST … IST → KUL); a return ticket on the
 * first covers the second, so the choice is *two one-way tickets vs one return ticket*.
 *
 * Pure and dependency-light (types + airport city codes) so the server, the optimizer and the
 * browser all decide the same way.
 */

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const SAME_PLACE_KM = 30;
/** Fares within this many dollars are a tie (one-way wins: it is the more flexible choice). */
const TIE_USD = 0.5;

function km(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

type PlaceLike = Pick<TripStop, 'iataCode' | 'lat' | 'lng'>;

function samePlace(a: PlaceLike, b: PlaceLike): boolean {
  return (
    toMetroCode(a.iataCode) === toMetroCode(b.iataCode) ||
    km(a.lat, a.lng, b.lat, b.lng) <= SAME_PLACE_KM
  );
}

/**
 * For each leg index `i` (stop i → stop i+1), the later leg index `j` that goes back (stop j is
 * where leg i ended, stop j+1 is where it began). Each leg is covered by at most one return, and a
 * covered leg does not start another pair.
 */
export function pairStops(stops: PlaceLike[]): Record<number, number> {
  const pairs: Record<number, number> = {};
  const covered = new Set<number>();
  for (let i = 0; i < stops.length - 1; i++) {
    if (covered.has(i)) continue;
    for (let j = i + 1; j < stops.length - 1; j++) {
      if (covered.has(j)) continue;
      if (samePlace(stops[j], stops[i + 1]) && samePlace(stops[j + 1], stops[i])) {
        pairs[i] = j;
        covered.add(j);
        break;
      }
    }
  }
  return pairs;
}

/** Identity of a leg's fare search. Equal keys mean live fares can be reused as they are. */
export function legFareKey(
  from: Pick<TripStop, 'departureDate' | 'iataCode'>,
  to: Pick<TripStop, 'iataCode'>,
  passengers = 1
): string {
  return [from.departureDate, from.iataCode, to.iataCode, passengers].join('|');
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && ISO_RE.test(value);
}

/**
 * Date of the way back for the return ticket on leg `i`: the traveller's choice, else the date the
 * paired leg departs, else the day they leave the destination. Never before the outbound date.
 */
export function legReturnDate(
  stops: Pick<TripStop, 'departureDate'>[],
  i: number,
  pairs: Record<number, number>,
  pref?: LegTicketPref
): string {
  const outbound = stops[i].departureDate;
  const candidate = isIsoDate(pref?.returnDate)
    ? pref!.returnDate!
    : pairs[i] !== undefined
      ? stops[pairs[i]].departureDate
      : stops[i + 1].departureDate;
  return candidate < outbound ? outbound : candidate;
}

/** A leg needs return fares when a return would cover another leg, or the traveller asked for one. */
export function wantsReturnFares(
  i: number,
  pairs: Record<number, number>,
  pref?: LegTicketPref
): boolean {
  return pairs[i] !== undefined || pref?.type === 'return';
}

function hasLive(options: TransitOption[] | undefined): boolean {
  return !!options?.some((o) => (o.dataSource === 'live' || o.dataSource === 'cached') && o.mode === 'flight');
}

function cheapest(options: TransitOption[] | undefined, flightsOnly: boolean): TransitOption | null {
  let best: TransitOption | null = null;
  for (const o of options ?? []) {
    if (flightsOnly && o.mode !== 'flight') continue;
    if (!best || o.basePriceUsd < best.basePriceUsd) best = o;
  }
  return best;
}

/**
 * Price the two structures against each other. With live fares on all three lists the comparison is
 * decisive and counts flights only (those are the tickets whose structure differs). Otherwise it is
 * an `estimate`: shown for information, never used to switch the traveller's ticket.
 */
export function compareFares(
  leg: Pick<TripLeg, 'oneWayOptions' | 'returnOptions'>,
  pairedLeg: Pick<TripLeg, 'id' | 'oneWayOptions'>
): FareComparison | null {
  const live =
    hasLive(leg.oneWayOptions) && hasLive(pairedLeg.oneWayOptions) && hasLive(leg.returnOptions);
  const out = cheapest(leg.oneWayOptions, live);
  const back = cheapest(pairedLeg.oneWayOptions, live);
  const rt = cheapest(leg.returnOptions, live);
  if (!out || !back || !rt) return null;

  const oneWayTotalUsd = Math.round((out.basePriceUsd + back.basePriceUsd) * 100) / 100;
  const returnTotalUsd = rt.basePriceUsd;
  const diff = oneWayTotalUsd - returnTotalUsd;
  return {
    basis: live ? 'live' : 'estimate',
    pairedLegId: pairedLeg.id,
    oneWayTotalUsd,
    returnTotalUsd,
    cheaper: Math.abs(diff) <= TIE_USD ? 'tie' : diff > 0 ? 'return' : 'one-way',
    savingsUsd: Math.round(Math.abs(diff) * 100) / 100,
  };
}

/**
 * Settles every leg's ticket structure and makes `transitOptions` the matching list.
 *   - a traveller's choice (`prefs[leg.id]`) always wins;
 *   - otherwise a paired leg switches to a return ticket when live fares say it is cheaper;
 *   - a leg covered by a return ticket is flagged so it is not paid for twice.
 * Returns new leg objects; inputs are not mutated.
 */
export function finalizeLegs(
  legs: TripLeg[],
  prefs: Record<string, LegTicketPref> | undefined
): TripLeg[] {
  const byId = new Map(legs.map((l) => [l.id, l]));
  const decided = legs.map((leg): TripLeg => {
    const oneWay = leg.oneWayOptions ?? leg.transitOptions;
    const returnOptions = leg.returnOptions;
    const paired = leg.pairedLegId ? byId.get(leg.pairedLegId) : undefined;
    const comparison =
      paired && returnOptions?.length
        ? compareFares({ oneWayOptions: oneWay, returnOptions }, {
            id: paired.id,
            oneWayOptions: paired.oneWayOptions ?? paired.transitOptions,
          })
        : null;

    const pref = prefs?.[leg.id];
    let type: TicketType = pref
      ? pref.type
      : comparison?.basis === 'live' && comparison.cheaper === 'return'
        ? 'return'
        : 'one-way';
    // A return can only be shown once its fares exist (the server fetches them on demand)
    if (type === 'return' && !returnOptions?.length) type = 'one-way';

    const active = type === 'return' ? returnOptions! : oneWay;
    const keep = active.some((o) => o.id === leg.selectedOptionId);
    return {
      ...leg,
      oneWayOptions: oneWay,
      returnOptions,
      ticketType: type,
      ticketLocked: Boolean(pref),
      fareComparison: comparison ?? undefined,
      coveredByLegId: undefined,
      transitOptions: active,
      selectedOptionId: keep ? leg.selectedOptionId : (active[0]?.id ?? ''),
    };
  });

  const result = new Map(decided.map((l) => [l.id, l]));
  for (const leg of decided) {
    if (leg.ticketType === 'return' && leg.pairedLegId) {
      const covered = result.get(leg.pairedLegId);
      if (covered) result.set(covered.id, { ...covered, coveredByLegId: leg.id });
    }
  }
  return legs.map((l) => result.get(l.id)!);
}

/** What one leg adds to the trip totals. A covered leg adds nothing: its fare is in the return. */
export function legTotals(leg: TripLeg): {
  costUsd: number;
  hours: number;
  score: number;
} {
  if (leg.coveredByLegId) return { costUsd: 0, hours: 0, score: 0 };
  const selected = leg.transitOptions.find((o) => o.id === leg.selectedOptionId) ?? leg.transitOptions[0];
  if (!selected) return { costUsd: 0, hours: 0, score: 0 };
  const journeys = selected.ticketType === 'return' ? 2 : 1;
  return {
    costUsd: selected.basePriceUsd,
    hours: (selected.inVehicleHours + selected.layoverHours) * journeys,
    score: selected.smartScore,
  };
}
