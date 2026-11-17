import { getEnv, warnMissingKey } from './env.ts';
import { getJson, setJson } from './jsonCache.ts';
import type { HotelResult } from '../shared/types.ts';

/**
 * Live hotels from Google Hotels through SerpApi (`engine=google_hotels`). One search costs one
 * SerpApi credit, so results are cached for 24 hours per city, dates, party size and currency, and
 * the caller only asks for a stop the user has opened.
 */

export const HOTEL_CACHE_TTL_SECONDS = 24 * 60 * 60;
const TIMEOUT_MS = 12_000;
const MAX_HOTELS = 12;

export const serpApiHotelsKey = (): string | undefined => getEnv('SERPAPI_API_KEY');

export interface HotelQuery {
  city: string;
  country?: string;
  /** `YYYY-MM-DD`; check-out must be after check-in. */
  checkIn: string;
  checkOut: string;
  adults: number;
}

const nightsBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

interface RawProperty {
  name?: string;
  type?: string;
  link?: string;
  property_token?: string;
  gps_coordinates?: { latitude?: number; longitude?: number };
  extracted_hotel_class?: number;
  hotel_class?: string;
  overall_rating?: number;
  reviews?: number;
  amenities?: string[];
  images?: { thumbnail?: string }[];
  rate_per_night?: { extracted_lowest?: number };
  total_rate?: { extracted_lowest?: number };
  deal_description?: string;
  deal?: string;
}

/** Hotels out of a SerpApi response. Exported for tests. */
export function parseHotels(data: { properties?: RawProperty[] }, nights: number): HotelResult[] {
  const out: HotelResult[] = [];
  for (const p of data.properties ?? []) {
    const name = p.name?.trim();
    const nightly = Number(p.rate_per_night?.extracted_lowest);
    if (!name || !(nightly > 0)) continue; // no price, no card: nothing is invented
    const total = Number(p.total_rate?.extracted_lowest);
    const stars = p.extracted_hotel_class ?? Number(/(\d)/.exec(p.hotel_class ?? '')?.[1]);
    const thumb = p.images?.[0]?.thumbnail;
    out.push({
      id: p.property_token ?? `${name}-${out.length}`,
      name,
      type: p.type,
      stars: stars >= 1 && stars <= 5 ? stars : undefined,
      rating: p.overall_rating && p.overall_rating > 0 ? Math.round(p.overall_rating * 10) / 10 : undefined,
      reviews: p.reviews,
      thumbnailUrl: thumb && /^https:\/\//.test(thumb) ? thumb : undefined,
      amenities: Array.isArray(p.amenities) ? p.amenities.slice(0, 24) : [],
      nightlyUsd: nightly,
      totalUsd: total > 0 ? total : Math.round(nightly * nights * 100) / 100,
      nights,
      link: p.link && /^https?:\/\//.test(p.link) ? p.link : undefined,
      deal: p.deal_description ?? p.deal,
      lat: p.gps_coordinates?.latitude,
      lng: p.gps_coordinates?.longitude,
    });
    if (out.length >= MAX_HOTELS) break;
  }
  return out;
}

/** Hotels for a city and dates, or null with no key, no results or an API error. */
export async function fetchHotels(q: HotelQuery): Promise<{ hotels: HotelResult[]; cached: boolean } | null> {
  const key = serpApiHotelsKey();
  if (!key) {
    warnMissingKey('SERPAPI_API_KEY', 'live hotel search');
    return null;
  }
  const nights = nightsBetween(q.checkIn, q.checkOut);
  if (!(nights >= 1)) return null;

  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '-');
  const cacheKey = `hotels:v1:${norm(q.city)}:${norm(q.country ?? '')}:${q.checkIn}:${q.checkOut}:${q.adults}:usd`;
  const cached = await getJson<HotelResult[]>(cacheKey);
  if (cached) return cached.length > 0 ? { hotels: cached, cached: true } : null;

  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google_hotels');
  url.searchParams.set('q', `${q.city}${q.country ? `, ${q.country}` : ''} hotels`);
  url.searchParams.set('check_in_date', q.checkIn);
  url.searchParams.set('check_out_date', q.checkOut);
  url.searchParams.set('adults', String(q.adults));
  url.searchParams.set('currency', 'USD');
  url.searchParams.set('hl', 'en');
  url.searchParams.set('gl', 'us');
  url.searchParams.set('api_key', key);

  try {
    console.log(`[Hotels] SerpApi google_hotels: ${q.city} ${q.checkIn} -> ${q.checkOut} (${q.adults} adults)`);
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { error?: string } | null;
      console.warn(`[Hotels] SerpApi returned ${res.status}: ${detail?.error ?? res.statusText}`);
      return null;
    }
    const data = (await res.json()) as { properties?: RawProperty[]; error?: string };
    if (data.error) {
      console.warn(`[Hotels] SerpApi error: ${data.error}`);
      return null;
    }
    const hotels = parseHotels(data, nights);
    await setJson(cacheKey, hotels, HOTEL_CACHE_TTL_SECONDS);
    return hotels.length > 0 ? { hotels, cached: false } : null;
  } catch (err) {
    console.warn('[Hotels] Request failed or timed out:', err);
    return null;
  }
}
