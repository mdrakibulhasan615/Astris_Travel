import { fetchTravelpayoutsFlights, travelpayoutsToken } from './travelpayoutsService.ts';
import { ulccCarrier } from '../shared/ulcc.ts';
import type { TransitOption, TravelerProfile } from '../shared/types.ts';

/**
 * Fares on ultra-low-cost airlines Duffel does not sell (AirAsia, Ryanair…; see `shared/ulcc.ts`).
 * They come from recent real fares on the free Aviasales Data API and are tagged
 * `source: 'external_ulcc'` with the partner link, so the UI offers "Book direct on {carrier}"
 * instead of the Duffel checkout. Empty when no Travelpayouts token is set or no ULCC flies the route.
 */
export async function fetchUlccFallback(q: {
  origin: string;
  destination: string;
  date: string;
  returnDate?: string;
  legId: string;
  hourlyRateUsd: number;
  profile?: Partial<TravelerProfile>;
}): Promise<TransitOption[]> {
  if (!travelpayoutsToken()) return [];
  const fares = await fetchTravelpayoutsFlights(q);
  if (!fares) return [];
  return fares
    .filter((o) => o.mode === 'flight' && ulccCarrier(o.carrierCode) && o.sourceFareUrl)
    .map((o) => ({
      ...o,
      id: `${o.id}-ulcc`,
      source: 'external_ulcc' as const,
      affiliateUrl: o.sourceFareUrl,
      // The partner link is the only way to buy it: no merchant comparison rows
      offers: undefined,
    }));
}
