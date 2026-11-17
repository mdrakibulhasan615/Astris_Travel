import { recalculateOptions } from '../shared/smartScore.ts';
import type { FallbackLink, OfflineReason } from '../shared/liveFlights.ts';
import type { TransitOption, TravelerProfile, TripLeg } from '../shared/types.ts';

/**
 * Live fares the traveller fetched for one leg. They live next to the trip, not inside it: every edit
 * rebuilds the legs from the server's recent fares, and a fetched fare (which cost a search)
 * must survive that for as long as the search it answers is still the one on screen.
 */
export interface LiveFareEntry {
  /** The search this answers (`legLiveKey`); a different date or ticket type ignores it. */
  key: string;
  mode: 'live' | 'offline';
  options: TransitOption[];
  fetchedAt: string;
  /** This answer came from the 30-minute cache (no search was spent). */
  cached: boolean;
  reason?: OfflineReason;
  fallbackLinks: FallbackLink[];
}

export interface LiveFareStatus {
  loading: boolean;
  error?: string;
}

/** What identifies a leg's fare search: route, date and ticket type. */
export function legLiveKey(leg: TripLeg): string {
  return [leg.id, leg.fromCode, leg.toCode, leg.departureDate ?? '', leg.ticketType ?? 'one-way', leg.returnDate ?? ''].join('|');
}

/**
 * The leg with its flights swapped for the live fares, when a live answer for exactly this search is
 * on hand and found flights. Ground options stay; everything is re-scored together. An offline answer
 * or an empty one leaves the leg as it was.
 */
export function mergeLiveFares(
  leg: TripLeg,
  entry: LiveFareEntry | undefined,
  hourlyRateUsd: number,
  profile?: Partial<TravelerProfile>
): TripLeg {
  if (!entry || entry.mode !== 'live' || entry.options.length === 0 || entry.key !== legLiveKey(leg)) return leg;

  const isReturn = leg.ticketType === 'return';
  const base = isReturn ? (leg.returnOptions ?? leg.transitOptions) : (leg.oneWayOptions ?? leg.transitOptions);
  const ground = base.filter((o) => o.mode !== 'flight');
  const live = entry.options.map((o) => ({ ...o, legId: leg.id }));
  const merged = recalculateOptions([...live, ...ground], hourlyRateUsd, profile);

  const selected = merged.some((o) => o.id === leg.selectedOptionId) ? leg.selectedOptionId : (merged[0]?.id ?? '');
  return {
    ...leg,
    transitOptions: merged,
    ...(isReturn ? { returnOptions: merged } : { oneWayOptions: merged }),
    selectedOptionId: selected,
  };
}
