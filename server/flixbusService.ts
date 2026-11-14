import { getEnv } from './env.ts';

/**
 * FlixBus city ids. FlixBus's shop search only accepts its own city UUIDs
 * (`?departureCity=40dfdfd8-…&arrivalCity=40de8964-…`), so a deep link needs a lookup from the
 * city name. This uses the same public autocomplete endpoint as the search box on flixbus.com.
 * It is not a documented partner API: treat every failure as "FlixBus not available" and let the
 * caller fall back to another merchant. Set `FLIXBUS_CITY_LOOKUP=off` to disable the calls.
 *
 * Results (including "FlixBus does not serve this city") are cached in memory for a day.
 */

const AUTOCOMPLETE_URL = 'https://global.api.flixbus.com/search/autocomplete/cities';
const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const ERROR_TTL_MS = 10 * 60 * 1000;
const MAX_MATCH_KM = 60; // a "Paris" 300 km from the stop is a different Paris
const CACHE_MAX = 500;

interface FlixCity {
  id?: string;
  name?: string;
  is_flixbus_city?: boolean;
  location?: { lat?: number; lon?: number };
}

interface CityQuery {
  city: string;
  lat: number;
  lng: number;
}

const cache = new Map<string, { id: string | null; expires: number }>();
const inFlight = new Map<string, Promise<string | null>>();

function isEnabled(): boolean {
  const flag = (getEnv('FLIXBUS_CITY_LOOKUP') ?? '').toLowerCase();
  return !['off', 'false', '0', 'no'].includes(flag);
}

function km(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function remember(key: string, id: string | null, ttlMs: number): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { id, expires: Date.now() + ttlMs });
}

async function lookup(query: CityQuery, key: string): Promise<string | null> {
  try {
    const url = new URL(AUTOCOMPLETE_URL);
    url.searchParams.set('q', query.city);
    url.searchParams.set('lang', 'en');
    url.searchParams.set('country', 'en');
    url.searchParams.set('flixbus_cities_only', 'false');
    url.searchParams.set('stations', 'false');
    url.searchParams.set('popular_stations', 'false');

    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cities = (await res.json()) as FlixCity[];

    // The name search returns airports and namesakes too ("London Heathrow Airport", "London, ON"),
    // so the stop's own coordinates decide which result is the city we mean.
    let best: { id: string; km: number } | null = null;
    for (const city of Array.isArray(cities) ? cities : []) {
      const lat = Number(city.location?.lat);
      const lon = Number(city.location?.lon);
      if (!city.id || city.is_flixbus_city === false || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        continue;
      }
      const d = km(query.lat, query.lng, lat, lon);
      if (d <= MAX_MATCH_KM && (!best || d < best.km)) best = { id: city.id, km: d };
    }
    remember(key, best?.id ?? null, HIT_TTL_MS);
    return best?.id ?? null;
  } catch (err) {
    console.warn(`[FlixBus] city lookup failed for "${query.city}":`, (err as Error)?.message ?? err);
    remember(key, null, ERROR_TTL_MS);
    return null;
  }
}

/** FlixBus city id for the city nearest the given point, or null (unserved, disabled, or failed). */
export async function resolveFlixbusCityId(query: CityQuery): Promise<string | null> {
  const city = query.city?.trim();
  if (!city || !isEnabled() || !Number.isFinite(query.lat) || !Number.isFinite(query.lng)) return null;

  const key = `${city.toLowerCase()}|${query.lat.toFixed(1)}|${query.lng.toFixed(1)}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.id;

  let pending = inFlight.get(key);
  if (!pending) {
    pending = lookup({ ...query, city }, key).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

/** Both ends of a corridor, or null unless FlixBus serves both. */
export async function resolveFlixbusRoute(
  from: CityQuery,
  to: CityQuery
): Promise<{ fromCityId: string; toCityId: string } | null> {
  const [fromCityId, toCityId] = await Promise.all([
    resolveFlixbusCityId(from),
    resolveFlixbusCityId(to),
  ]);
  return fromCityId && toCityId && fromCityId !== toCityId ? { fromCityId, toCityId } : null;
}
