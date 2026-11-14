// MUST stay the first import so env is loaded before the Redis/SerpApi clients are configured
import { getEnv, warnMissingKey } from './env.ts';
import { Redis } from '@upstash/redis';
import {
  CURATED_CORRIDOR_OPTIONS,
  DESTINATION_HUBS,
  VOUCHERS_CATALOG,
} from '../shared/mockDataset.ts';
import { attachBookingUrls, configureAffiliate, isFlixCarrier } from '../shared/affiliate.ts';
import {
  normalizeOptionGeometry,
  registerAirportResolver,
  resolveAirport,
} from '../shared/airports.ts';
import {
  computeSmartScore,
  haversineDistanceKm,
  recalculateOptionsWithVttsAndVouchers,
  round2,
  synthesizeCorridorOptions,
} from '../shared/smartScore.ts';
import type {
  TransitMode,
  TransitOption,
  TransitSegment,
  TravelerProfile,
  TripStop,
  Voucher,
} from '../shared/types.ts';
import { getAirportByIata } from './airportService.ts';
import { resolveFlixbusRoute } from './flixbusService.ts';

// Give the shared airport-anchoring logic the full global dataset (6,300+ airports) server-side.
registerAirportResolver((code) => {
  const airport = getAirportByIata(code);
  return airport
    ? { code: airport.iataCode, name: airport.tagline || airport.city, lat: airport.lat, lng: airport.lng }
    : null;
});

// Partner ids for the direct merchant links (see shared/affiliate.ts). Every id is optional:
// without one, that merchant's links still land on the exact search, just un-attributed.
configureAffiliate({
  tripcomAllianceId: getEnv('TRIPCOM_ALLIANCE_ID'),
  tripcomSid: getEnv('TRIPCOM_SID'),
  bookingAid: getEnv('BOOKING_AID'),
  agodaCid: getEnv('AGODA_CID'),
  twelveGoAffiliateId: getEnv('TWELVEGO_AFFILIATE_ID'),
  trackingTemplates: {
    tripcom: getEnv('TRIPCOM_TRACKING_TEMPLATE'),
    flixbus: getEnv('FLIXBUS_TRACKING_TEMPLATE'),
    '12go': getEnv('TWELVEGO_TRACKING_TEMPLATE'),
    booking: getEnv('BOOKING_TRACKING_TEMPLATE'),
    agoda: getEnv('AGODA_TRACKING_TEMPLATE'),
  },
  debug: process.env.NODE_ENV !== 'production',
});

export const REDIS_CACHE_TTL_SECONDS = 43200; // 12 hours (EX: 43200)

// Read lazily (not captured at import time); placeholder values count as missing
const upstashUrl = () => getEnv('UPSTASH_REDIS_REST_URL');
const upstashToken = () => getEnv('UPSTASH_REDIS_REST_TOKEN');
const serpApiKey = () => getEnv('SERPAPI_KEY');

let redisClient: Redis | null = null;
let redisInitialized = false;

export function getRedisClient(): Redis | null {
  if (redisInitialized) {
    return redisClient;
  }
  redisInitialized = true;

  const url = upstashUrl();
  const token = upstashToken();
  if (url && token) {
    try {
      redisClient = new Redis({ url, token });
      console.log('[Upstash Redis] Client initialized with endpoint:', url);
    } catch (err) {
      console.warn('[Upstash Redis] Initialization failed, will use fallback:', err);
      redisClient = null;
    }
  } else {
    if (!url) warnMissingKey('UPSTASH_REDIS_REST_URL', 'Redis cache');
    if (!token) warnMissingKey('UPSTASH_REDIS_REST_TOKEN', 'Redis cache');
    redisClient = null;
  }

  return redisClient;
}

export function isRedisConfigured(): boolean {
  return Boolean(upstashUrl() && upstashToken());
}

export async function checkRedisConnection(): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;
  try {
    const pong = await client.ping();
    return pong === 'PONG' || pong === 'OK' || Boolean(pong);
  } catch (err) {
    console.warn('[Upstash Redis] Ping check failed:', err);
    return false;
  }
}

/**
 * Deterministic cache key generator:
 * transit:cache:${origin}:${destination}:${date}:${mode}
 */
export function buildTransitCacheKey(
  origin: string,
  destination: string,
  date: string,
  mode: string = 'all'
): string {
  const normOrigin = (origin || 'UNKNOWN').trim().toUpperCase();
  const normDest = (destination || 'UNKNOWN').trim().toUpperCase();
  const normDate = (date || 'ANY').trim();
  const normMode = (mode || 'all').trim().toLowerCase();
  return `transit:cache:${normOrigin}:${normDest}:${normDate}:${normMode}`;
}

// In-process L1 cache so repeated page loads don't burn SerpApi quota when Redis is absent or
// down. Same 12-hour TTL as Redis. Only LIVE results are ever cached (see queryTransitWithCache).
const MEMORY_CACHE_MAX = 200;
const memoryCache = new Map<string, { expires: number; options: TransitOption[] }>();

function getMemoryCached(cacheKey: string): TransitOption[] | null {
  const hit = memoryCache.get(cacheKey);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    memoryCache.delete(cacheKey);
    return null;
  }
  return hit.options;
}

function setMemoryCached(cacheKey: string, options: TransitOption[]): void {
  if (memoryCache.size >= MEMORY_CACHE_MAX) {
    const oldest = memoryCache.keys().next().value;
    if (oldest !== undefined) memoryCache.delete(oldest);
  }
  memoryCache.set(cacheKey, { expires: Date.now() + REDIS_CACHE_TTL_SECONDS * 1000, options });
}

export async function getCachedTransit(
  cacheKey: string
): Promise<{ options: TransitOption[]; layer: 'memory' | 'redis' } | null> {
  const mem = getMemoryCached(cacheKey);
  if (mem) return { options: mem, layer: 'memory' };

  const client = getRedisClient();
  if (!client) return null;

  try {
    const cached = await client.get<TransitOption[]>(cacheKey);
    if (cached && Array.isArray(cached) && cached.length > 0) {
      console.log(`[Upstash Redis] Cache HIT for key: ${cacheKey} (${cached.length} options)`);
      setMemoryCached(cacheKey, cached);
      return { options: cached, layer: 'redis' };
    }
    console.log(`[Upstash Redis] Cache MISS for key: ${cacheKey}`);
  } catch (err) {
    console.warn(`[Upstash Redis] Failed to retrieve key "${cacheKey}", proceeding to live/fallback:`, err);
  }
  return null;
}

export async function setCachedTransit(
  cacheKey: string,
  options: TransitOption[]
): Promise<boolean> {
  if (!options || options.length === 0) return false;
  setMemoryCached(cacheKey, options);

  const client = getRedisClient();
  if (!client) return false;

  try {
    // 12-hour TTL: EX 43200
    await client.set(cacheKey, options, { ex: REDIS_CACHE_TTL_SECONDS });
    console.log(`[Upstash Redis] Stored ${options.length} options under key: ${cacheKey} (TTL: ${REDIS_CACHE_TTL_SECONDS}s)`);
    return true;
  } catch (err) {
    console.warn(`[Upstash Redis] Failed to cache key "${cacheKey}":`, err);
    return false;
  }
}

export interface TransitQueryParams {
  origin: string;
  destination: string;
  date: string;
  mode?: 'all' | TransitMode;
  hourlyRateUsd?: number;
  activeVouchers?: Voucher[];
  travelerProfile?: Partial<TravelerProfile>;
  passengers?: number;
  fromStop?: TripStop;
  toStop?: TripStop;
}

export interface TransitQueryResult {
  cacheKey: string;
  source: 'redis_cache' | 'memory_cache' | 'live_api' | 'fallback_corridor';
  cached: boolean;
  ttlSeconds: number;
  options: TransitOption[];
}

/**
 * Resolves the exact AIRPORT coordinates for an IATA (airport or metro/city) code via the shared
 * airport table and the global `airports` dataset (ARCHITECTURE.md §3). City-centre hub
 * coordinates are deliberately NOT used: flight lines must start and end on the tarmac.
 */
function resolveAirportCoords(
  code: string
): { lat: number; lng: number; code: string; city: string } | null {
  const airport = resolveAirport(code);
  if (!airport) return null;
  const meta = getAirportByIata(airport.code);
  return { lat: airport.lat, lng: airport.lng, code: airport.code, city: meta?.city ?? airport.name };
}

/** City-level coordinates for a trip stop (used for ground connectors and synthetic corridors). */
function resolveCityCoords(
  code: string,
  stop?: Pick<TripStop, 'lat' | 'lng' | 'city'>
): { lat: number; lng: number; city: string } {
  if (stop && Number.isFinite(stop.lat) && Number.isFinite(stop.lng)) {
    return { lat: stop.lat, lng: stop.lng, city: stop.city };
  }
  const hub = DESTINATION_HUBS.find((h) => h.iataCode.toUpperCase() === code.toUpperCase());
  if (hub) return { lat: hub.lat, lng: hub.lng, city: hub.city };
  const ap = resolveAirportCoords(code);
  if (ap) return { lat: ap.lat, lng: ap.lng, city: ap.city };
  // Only reachable from /api/transit/query with a code no dataset knows; such a query gets the
  // synthesized corridor with degenerate geometry rather than an error.
  console.warn(`[Transit API] Unknown location code "${code}"; no coordinates available.`);
  return { lat: 0, lng: 0, city: code.toUpperCase() };
}

/**
 * Attempts to fetch live flights from SerpAPI Google Flights engine when SERPAPI_KEY is configured.
 */
async function fetchSerpApiFlights(
  origin: string,
  destination: string,
  date: string,
  hourlyRateUsd: number,
  activeVouchers: Voucher[],
  profile: Partial<TravelerProfile> | undefined,
  fromStop?: TripStop,
  toStop?: TripStop
): Promise<TransitOption[] | null> {
  const apiKey = serpApiKey();
  if (!apiKey) {
    warnMissingKey('SERPAPI_KEY', 'live flight search');
    return null;
  }

  try {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'google_flights');
    url.searchParams.set('departure_id', origin);
    url.searchParams.set('arrival_id', destination);
    url.searchParams.set('outbound_date', date);
    url.searchParams.set('currency', 'USD');
    url.searchParams.set('hl', 'en');
    url.searchParams.set('api_key', apiKey);

    console.log(`[Transit API] Querying SerpAPI Google Flights: ${origin} -> ${destination} on ${date}...`);
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.warn(`[Transit API] SerpAPI returned status ${res.status}: ${res.statusText}`);
      if (res.status === 401 || res.status === 403) {
        console.warn('[env] SERPAPI_KEY was rejected by SerpApi (401/403). Check the key in .env.local.');
      }
      return null;
    }

    const data = await res.json();
    const flightGroups = [
      ...(Array.isArray(data.best_flights) ? data.best_flights : []),
      ...(Array.isArray(data.other_flights) ? data.other_flights : []),
    ];

    if (flightGroups.length === 0) {
      console.log('[Transit API] No flights found in SerpAPI response, falling back.');
      return null;
    }

    const fromPoint = resolveCityCoords(origin, fromStop);
    const toPoint = resolveCityCoords(destination, toStop);
    const distanceKm = haversineDistanceKm(fromPoint.lat, fromPoint.lng, toPoint.lat, toPoint.lng);
    const legId = `leg-${origin.toLowerCase()}-${destination.toLowerCase()}`;

    // Provider timestamps look like "2026-11-21 09:30"
    const parseStamp = (t?: string) => {
      const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})/.exec(t ?? '');
      return m ? { date: m[1], clock: m[2].padStart(5, '0') } : null;
    };
    const dayDiff = (from: string, to: string) =>
      Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

    // Options are built ONLY from fields the provider returned. A missing price/duration drops the
    // option rather than substituting an invented value (a made-up fare shown as real is worse
    // than one fewer row).
    const rawOptions: TransitOption[] = [];
    let skipped = 0;
    flightGroups.slice(0, 6).forEach((item, idx) => {
      const flights = Array.isArray(item.flights) ? item.flights : [];
      const priceUsd = Number(item.price);
      if (flights.length === 0 || !(priceUsd > 0)) {
        skipped++;
        return;
      }

      const firstFlt = flights[0];
      const lastFlt = flights[flights.length - 1];
      const flightNumbers: string[] = flights
        .map((f: { flight_number?: string }) => (f.flight_number ?? '').trim())
        .filter(Boolean);
      const carriers: string[] = Array.from(
        new Set<string>(
          flights.map((f: { airline?: string }) => (f.airline ?? '').trim()).filter(Boolean)
        )
      );
      // "TK 61" -> "TK"; falls back to the airline's initials only if no flight number exists
      const carrierCode = (
        /^([A-Z0-9]{2})\s*\d/i.exec(flightNumbers[0] ?? '')?.[1] ??
        (carriers[0] ?? '').slice(0, 2)
      ).toUpperCase();

      const layovers = Array.isArray(item.layovers) ? item.layovers : [];
      const layoverMinutes = layovers.reduce(
        (sum: number, l: { duration?: number }) => sum + (Number(l.duration) || 0),
        0
      );
      const hopMinutes = flights.reduce(
        (sum: number, f: { duration?: number }) => sum + (Number(f.duration) || 0),
        0
      );
      const totalMinutes = Number(item.total_duration) || hopMinutes + layoverMinutes;
      const inVehicleMinutes = totalMinutes - layoverMinutes > 0 ? totalMinutes - layoverMinutes : hopMinutes;
      if (!(inVehicleMinutes > 0)) {
        skipped++;
        return;
      }
      const inVehicleHours = round2(inVehicleMinutes / 60);
      const layoverHours = round2(layoverMinutes / 60);

      const dep = parseStamp(firstFlt.departure_airport?.time);
      const arr = parseStamp(lastFlt.arrival_airport?.time);
      const depTime = dep?.clock ?? '';
      const offset = dep && arr ? dayDiff(dep.date, arr.date) : 0;
      const arrTime = arr ? `${arr.clock}${offset > 0 ? ` +${offset}d` : ''}` : '';

      const eligibleVouchers = VOUCHERS_CATALOG.filter(
        (v) =>
          v.applicableModes.includes('flight') &&
          priceUsd >= v.minSpendUsd &&
          (!v.applicableCarriers ||
            v.applicableCarriers.length === 0 ||
            v.applicableCarriers.includes(carrierCode))
      ).map((v) => v.id);

      // Every hop is anchored to its OWN airport (SerpApi reports the real departure/arrival
      // airport, e.g. SAW vs IST), so connections render via the layover airport and a flight
      // line never starts or ends at a city centre. Ground connectors are added afterwards.
      // A hop whose airport no dataset knows cannot be drawn truthfully, so the fare is dropped
      // rather than given a line to an invented point.
      const hopAirports = flights.map(
        (flt: { departure_airport?: { id?: string }; arrival_airport?: { id?: string } }) => ({
          from: resolveAirportCoords(flt.departure_airport?.id || origin),
          to: resolveAirportCoords(flt.arrival_airport?.id || destination),
        })
      );
      if (hopAirports.some((h: { from: unknown; to: unknown }) => !h.from || !h.to)) {
        skipped++;
        return;
      }

      const segments: TransitSegment[] = flights.map((flt: {
        flight_number?: string;
        departure_airport?: { name?: string; id?: string };
        arrival_airport?: { name?: string; id?: string };
        duration?: number;
      }, segIdx: number) => {
        const segFrom = hopAirports[segIdx].from!;
        const segTo = hopAirports[segIdx].to!;
        return {
          id: `${legId}-serp-${idx + 1}-s${segIdx + 1}`,
          mode: 'flight' as TransitMode,
          label: flt.flight_number || `Flight ${segIdx + 1}`,
          fromName: flt.departure_airport?.name || segFrom.code,
          fromCode: segFrom.code,
          fromLat: segFrom.lat,
          fromLng: segFrom.lng,
          toName: flt.arrival_airport?.name || segTo.code,
          toCode: segTo.code,
          toLat: segTo.lat,
          toLng: segTo.lng,
          durationMinutes: Number(flt.duration) || Math.round(inVehicleMinutes / flights.length),
        };
      });

      const scorable = {
        departureTime: depTime,
        arrivalTime: arrTime,
        stopsCount: layovers.length,
        segments,
        basePriceUsd: priceUsd,
        inVehicleHours,
        layoverHours,
        isOvernightSleeper: false,
        mode: 'flight' as TransitMode,
        carrierCode,
        eligibleVoucherIds: eligibleVouchers,
      };
      const breakdown = computeSmartScore(scorable, hourlyRateUsd, null, profile);

      const co2FromApi = Number(item.carbon_emissions?.this_flight) / 1000;
      const originCode = segments[0].fromCode;
      const destCode = segments[segments.length - 1].toCode;

      rawOptions.push({
        id: `${legId}-serp-${idx + 1}`,
        legId,
        mode: 'flight',
        isOvernightSleeper: false,
        // Displayed verbatim from the provider
        carrier: carriers.join(' + ') || carrierCode,
        carrierCode,
        routeCode: flightNumbers.join(' + ') || `${originCode}-${destCode}`,
        flightNumbers,
        carriers,
        originStation: firstFlt.departure_airport?.name || `${originCode} Airport`,
        destinationStation: lastFlt.arrival_airport?.name || `${destCode} Airport`,
        departureTime: depTime,
        arrivalTime: arrTime,
        departureAt: firstFlt.departure_airport?.time,
        arrivalAt: lastFlt.arrival_airport?.time,
        inVehicleHours,
        layoverHours,
        layoverHub: layovers[0]?.id || undefined,
        stopsCount: layovers.length,
        basePriceUsd: priceUsd,
        discountedPriceUsd: breakdown.discountedPriceUsd,
        smartScore: breakdown.totalSmartScore,
        smartScoreBreakdown: breakdown,
        doorToDoorNotes: `${originCode} (${depTime || '--:--'}) → ${destCode} (${arrTime || '--:--'})`,
        // CO₂ is the one non-ticket field estimated when the provider omits it
        co2Kg: co2FromApi > 0 ? Math.round(co2FromApi) : Math.round(distanceKm * 0.12),
        eligibleVoucherIds: eligibleVouchers,
        appliedVoucherId: null,
        segments,
        dataSource: 'live',
      });
    });
    if (skipped > 0) {
      console.warn(
        `[Transit API] Skipped ${skipped} SerpApi itinerary(ies) missing price/duration/flights or with an unknown airport.`
      );
    }
    if (rawOptions.length === 0) return null;

    console.log(`[Transit API] Successfully parsed ${rawOptions.length} live flights from SerpAPI.`);
    return recalculateOptionsWithVttsAndVouchers(rawOptions, hourlyRateUsd, activeVouchers, profile);
  } catch (err) {
    console.warn('[Transit API] SerpAPI fetch failed or timed out:', err);
    return null;
  }
}

/**
 * Builds fallback options from curated corridor dataset or synthetic corridor engine.
 */
function buildFallbackCorridorOptions(
  origin: string,
  destination: string,
  hourlyRateUsd: number,
  activeVouchers: Voucher[],
  profile: Partial<TravelerProfile> | undefined,
  fromStop?: TripStop,
  toStop?: TripStop
): TransitOption[] {
  const corridorKey = `${origin.toUpperCase()}-${destination.toUpperCase()}`;
  const legId = `leg-${origin.toLowerCase()}-${destination.toLowerCase()}`;

  let baseOptions: TransitOption[];
  if (CURATED_CORRIDOR_OPTIONS[corridorKey]) {
    baseOptions = CURATED_CORRIDOR_OPTIONS[corridorKey].map((opt) => ({
      ...opt,
      legId,
    }));
  } else {
    const fromResolved = resolveCityCoords(origin);
    const toResolved = resolveCityCoords(destination);
    const fromCoords = fromStop || {
      id: `stop-${origin.toLowerCase()}`,
      order: 1,
      city: fromResolved.city,
      country: '',
      iataCode: origin.toUpperCase(),
      lat: fromResolved.lat,
      lng: fromResolved.lng,
      stayNights: 3,
      arrivalDate: '2026-11-18',
      departureDate: '2026-11-21',
    };

    const toCoords = toStop || {
      id: `stop-${destination.toLowerCase()}`,
      order: 2,
      city: toResolved.city,
      country: '',
      iataCode: destination.toUpperCase(),
      lat: toResolved.lat,
      lng: toResolved.lng,
      stayNights: 4,
      arrivalDate: '2026-11-21',
      departureDate: '2026-11-25',
    };

    baseOptions = synthesizeCorridorOptions(
      fromCoords,
      toCoords,
      legId,
      VOUCHERS_CATALOG,
      hourlyRateUsd,
      activeVouchers,
      profile
    );
  }

  return recalculateOptionsWithVttsAndVouchers(baseOptions, hourlyRateUsd, activeVouchers, profile);
}

/**
 * Caching Wrapper for Transit Queries:
 * 1. Generates deterministic cache key: transit:cache:${origin}:${destination}:${date}:${mode}
 * 2. Checks Upstash Redis for existing cached response.
 * 3. On cache miss: fetches live API or fallback corridor, computes VTTS Smart Score,
 *    stores in Redis with a 12-hour TTL (EX: 43200), and returns the options.
 * 4. Graceful fallback on connection or API errors.
 */
export async function queryTransitWithCache(
  params: TransitQueryParams
): Promise<TransitQueryResult> {
  const {
    origin,
    destination,
    date,
    mode = 'all',
    hourlyRateUsd = 15,
    activeVouchers = [],
    travelerProfile,
    passengers,
    fromStop,
    toStop,
  } = params;

  // Booking links are (re)built on every response — cached options may pre-date the current
  // affiliate marker, travel date, or route naming.
  const fromCity = resolveCityCoords(origin, fromStop);
  const toCity = resolveCityCoords(destination, toStop);
  const cityPoint = (code: string, c: { lat: number; lng: number; city: string }) => ({
    city: c.city,
    iataCode: code.trim().toUpperCase(),
    lat: c.lat,
    lng: c.lng,
  });
  const withBookingUrls = async (opts: TransitOption[]): Promise<TransitOption[]> => {
    // FlixBus needs its own city ids; only ask when this corridor actually has a FlixBus coach
    const flixbus = opts.some((o) => o.mode === 'bus' && isFlixCarrier(o))
      ? await resolveFlixbusRoute(
          { city: fromCity.city, lat: fromCity.lat, lng: fromCity.lng },
          { city: toCity.city, lat: toCity.lat, lng: toCity.lng }
        )
      : null;
    return attachBookingUrls(
      // Airport-anchor flights and bracket them with separate ground connectors
      opts.map((o) =>
        normalizeOptionGeometry(o, cityPoint(origin, fromCity), cityPoint(destination, toCity))
      ),
      {
        fromCode: origin.trim().toUpperCase(),
        toCode: destination.trim().toUpperCase(),
        fromCity: fromCity.city,
        toCity: toCity.city,
        date,
        passengers,
        flixbus,
      }
    );
  };

  const cacheKey = buildTransitCacheKey(origin, destination, date, mode);

  // 1. Check Redis cache
  const cachedHit = await getCachedTransit(cacheKey);
  if (cachedHit && cachedHit.options.length > 0) {
    // Re-score cached options in case hourlyRateUsd or activeVouchers changed
    const scoredCached = recalculateOptionsWithVttsAndVouchers(
      cachedHit.options,
      hourlyRateUsd,
      activeVouchers,
      travelerProfile
    );
    return {
      cacheKey,
      source: cachedHit.layer === 'memory' ? 'memory_cache' : 'redis_cache',
      cached: true,
      ttlSeconds: REDIS_CACHE_TTL_SECONDS,
      options: await withBookingUrls(scoredCached),
    };
  }

  // 2. Cache Miss: Attempt Live Transit API fetch if flight/all mode
  let liveOptions: TransitOption[] | null = null;
  if (mode === 'all' || mode === 'flight') {
    liveOptions = await fetchSerpApiFlights(
      origin,
      destination,
      date,
      hourlyRateUsd,
      activeVouchers,
      travelerProfile,
      fromStop,
      toStop
    );
  }

  let finalOptions: TransitOption[];
  let source: 'live_api' | 'fallback_corridor';

  if (liveOptions && liveOptions.length > 0) {
    finalOptions = liveOptions;
    source = 'live_api';
  } else {
    // 3. Graceful Fallback: Curated or synthesized multi-modal corridor dataset
    finalOptions = buildFallbackCorridorOptions(
      origin,
      destination,
      hourlyRateUsd,
      activeVouchers,
      travelerProfile,
      fromStop,
      toStop
    );
    source = 'fallback_corridor';
  }

  // Filter by requested mode if not 'all'
  if (mode !== 'all') {
    const filtered = finalOptions.filter((opt) => opt.mode === mode);
    if (filtered.length > 0) {
      finalOptions = filtered;
    }
  }

  // 4. Cache LIVE results only (12-hour TTL). Curated/synthesized fallbacks are cheap to rebuild and
  //    depend on the caller's stops; caching them made stale sample data masquerade as a cache hit
  //    and shadow real fares once the live API became reachable.
  if (source === 'live_api') {
    await setCachedTransit(cacheKey, finalOptions);
  }

  return {
    cacheKey,
    source,
    cached: false,
    ttlSeconds: REDIS_CACHE_TTL_SECONDS,
    options: await withBookingUrls(finalOptions),
  };
}
