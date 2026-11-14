import { Redis } from '@upstash/redis';
import dotenv from 'dotenv';
import {
  CURATED_CORRIDOR_OPTIONS,
  DESTINATION_HUBS,
  VOUCHERS_CATALOG,
} from '../shared/mockDataset.ts';
import { attachBookingUrls, configureAffiliate } from '../shared/affiliate.ts';
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

// Load environment variables (.env.local first, then .env)
dotenv.config({ path: '.env.local' });
dotenv.config();

// Travelpayouts affiliate attribution (see shared/affiliate.ts). Without a marker, links are
// still valid but un-attributed.
configureAffiliate({
  marker: process.env.TRAVELPAYOUTS_MARKER,
  trs: process.env.TRAVELPAYOUTS_TRS,
  campaignId: process.env.TRAVELPAYOUTS_CAMPAIGN_ID,
  programId: process.env.TRAVELPAYOUTS_PROGRAM_ID,
});

export const REDIS_CACHE_TTL_SECONDS = 43200; // 12 hours (EX: 43200)

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL?.trim();
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
const SERPAPI_KEY = process.env.SERPAPI_KEY?.trim();

let redisClient: Redis | null = null;
let redisInitialized = false;

export function getRedisClient(): Redis | null {
  if (redisInitialized) {
    return redisClient;
  }
  redisInitialized = true;

  if (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) {
    try {
      redisClient = new Redis({
        url: UPSTASH_REDIS_REST_URL,
        token: UPSTASH_REDIS_REST_TOKEN,
      });
      console.log('[Upstash Redis] Client initialized with endpoint:', UPSTASH_REDIS_REST_URL);
    } catch (err) {
      console.warn('[Upstash Redis] Initialization failed, will use fallback:', err);
      redisClient = null;
    }
  } else {
    console.log('[Upstash Redis] Credentials not found in .env.local; active fallback mode.');
    redisClient = null;
  }

  return redisClient;
}

export function isRedisConfigured(): boolean {
  return Boolean(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);
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

export async function getCachedTransit(
  cacheKey: string
): Promise<TransitOption[] | null> {
  const client = getRedisClient();
  if (!client) return null;

  try {
    const cached = await client.get<TransitOption[]>(cacheKey);
    if (cached && Array.isArray(cached) && cached.length > 0) {
      console.log(`[Upstash Redis] Cache HIT for key: ${cacheKey} (${cached.length} options)`);
      return cached;
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
  const client = getRedisClient();
  if (!client || !options || options.length === 0) return false;

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
  source: 'redis_cache' | 'live_api' | 'fallback_corridor';
  cached: boolean;
  ttlSeconds: number;
  options: TransitOption[];
}

/**
 * Resolves exact coordinates for an IATA code. Order: caller-supplied stop → curated hubs →
 * the global `airports` dataset (per ARCHITECTURE.md §3). Previously anything outside the ~20
 * curated hubs silently resolved to Paris, corrupting distances, CO₂ and map arcs.
 */
function resolveCoordinates(
  code: string,
  stop?: Pick<TripStop, 'lat' | 'lng' | 'city'>
): { lat: number; lng: number; city: string } {
  if (stop && Number.isFinite(stop.lat) && Number.isFinite(stop.lng)) {
    return { lat: stop.lat, lng: stop.lng, city: stop.city };
  }
  const upper = code.toUpperCase();
  const match =
    DESTINATION_HUBS.find((h) => h.iataCode.toUpperCase() === upper) ?? getAirportByIata(upper);
  if (match) {
    return { lat: match.lat, lng: match.lng, city: match.city };
  }
  console.warn(`[Transit API] Unknown IATA code "${code}"; coordinates unavailable, using 0,0.`);
  return { lat: 0, lng: 0, city: code };
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
  if (!SERPAPI_KEY) return null;

  try {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'google_flights');
    url.searchParams.set('departure_id', origin);
    url.searchParams.set('arrival_id', destination);
    url.searchParams.set('outbound_date', date);
    url.searchParams.set('currency', 'USD');
    url.searchParams.set('hl', 'en');
    url.searchParams.set('api_key', SERPAPI_KEY);

    console.log(`[Transit API] Querying SerpAPI Google Flights: ${origin} -> ${destination} on ${date}...`);
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.warn(`[Transit API] SerpAPI returned status ${res.status}: ${res.statusText}`);
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

    const fromCoords = resolveCoordinates(origin, fromStop);
    const toCoords = resolveCoordinates(destination, toStop);
    const distanceKm = haversineDistanceKm(fromCoords.lat, fromCoords.lng, toCoords.lat, toCoords.lng);
    const legId = `leg-${origin.toLowerCase()}-${destination.toLowerCase()}`;

    const rawOptions: TransitOption[] = flightGroups.slice(0, 6).map((item, idx) => {
      const flights = Array.isArray(item.flights) ? item.flights : [];
      const firstFlt = flights[0] || {};
      const lastFlt = flights[flights.length - 1] || firstFlt;
      const carrier = firstFlt.airline || 'Commercial Airline';
      const flightNum = firstFlt.flight_number || `${origin}-${destination}`;
      const carrierCode = (firstFlt.flight_number?.slice(0, 2) || carrier.slice(0, 2)).toUpperCase();

      const totalDurationMinutes = Number(item.total_duration) || 180;
      const layovers = Array.isArray(item.layovers) ? item.layovers : [];
      const layoverMinutes = layovers.reduce(
        (sum: number, l: { duration?: number }) => sum + (Number(l.duration) || 0),
        0
      );
      const inVehicleMinutes = Math.max(30, totalDurationMinutes - layoverMinutes);

      const inVehicleHours = round2(inVehicleMinutes / 60);
      const layoverHours = round2(layoverMinutes / 60);
      const priceUsd = Number(item.price) || Math.round(95 + distanceKm * 0.05);

      // SerpApi returns "YYYY-MM-DD HH:MM"; keep just the clock time so the engine can parse it
      const clock = (t?: string) => /(\d{1,2}:\d{2})\s*$/.exec(t ?? '')?.[1];
      const depTime = clock(firstFlt.departure_airport?.time) || '09:00';
      const arrTime = clock(lastFlt.arrival_airport?.time) || '14:30';

      const eligibleVouchers = VOUCHERS_CATALOG.filter(
        (v) =>
          v.applicableModes.includes('flight') &&
          priceUsd >= v.minSpendUsd &&
          (!v.applicableCarriers ||
            v.applicableCarriers.length === 0 ||
            v.applicableCarriers.includes(carrierCode))
      ).map((v) => v.id);

      const segments: TransitSegment[] = flights.map((flt: {
        flight_number?: string;
        departure_airport?: { name?: string; id?: string };
        arrival_airport?: { name?: string; id?: string };
        duration?: number;
      }, segIdx: number) => {
        // Resolve each hop's own airport so connections render via the layover hub,
        // not as N overlapping origin→destination arcs.
        const segFromCode = flt.departure_airport?.id || origin;
        const segToCode = flt.arrival_airport?.id || destination;
        const segFrom = segIdx === 0 ? fromCoords : resolveCoordinates(segFromCode);
        const segTo = segIdx === flights.length - 1 ? toCoords : resolveCoordinates(segToCode);
        return {
          id: `${legId}-serp-s${segIdx + 1}`,
          mode: 'flight' as TransitMode,
          label: flt.flight_number || `Flight ${segIdx + 1}`,
          fromName: flt.departure_airport?.name || origin,
          fromCode: segFromCode,
          fromLat: segFrom.lat,
          fromLng: segFrom.lng,
          toName: flt.arrival_airport?.name || destination,
          toCode: segToCode,
          toLat: segTo.lat,
          toLng: segTo.lng,
          durationMinutes: Number(flt.duration) || Math.round(inVehicleMinutes / Math.max(1, flights.length)),
        };
      });

      const dummyOption = {
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

      const breakdown = computeSmartScore(dummyOption, hourlyRateUsd, null, profile);

      return {
        id: `${legId}-serp-${idx + 1}`,
        legId,
        mode: 'flight',
        isOvernightSleeper: false,
        carrier,
        carrierCode,
        routeCode: flightNum,
        originStation: firstFlt.departure_airport?.name || `${origin} Airport`,
        destinationStation: lastFlt.arrival_airport?.name || `${destination} Airport`,
        departureTime: depTime,
        arrivalTime: arrTime,
        inVehicleHours,
        layoverHours,
        layoverHub: layovers[0]?.id || undefined,
        stopsCount: layovers.length,
        basePriceUsd: priceUsd,
        discountedPriceUsd: breakdown.discountedPriceUsd,
        smartScore: breakdown.totalSmartScore,
        smartScoreBreakdown: breakdown,
        doorToDoorNotes: `${origin} Airport (${depTime}) → ${destination} (${arrTime})`,
        co2Kg: Math.round(Number(item.carbon_emissions?.this_flight) / 1000) || Math.round(distanceKm * 0.12),
        eligibleVoucherIds: eligibleVouchers,
        appliedVoucherId: null,
        segments,
      };
    });

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
    const fromResolved = resolveCoordinates(origin);
    const toResolved = resolveCoordinates(destination);
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
  const withBookingUrls = (opts: TransitOption[]) =>
    attachBookingUrls(opts, {
      fromCode: origin.trim().toUpperCase(),
      toCode: destination.trim().toUpperCase(),
      fromCity: fromStop?.city,
      toCity: toStop?.city,
      date,
      passengers,
    });

  const cacheKey = buildTransitCacheKey(origin, destination, date, mode);

  // 1. Check Redis cache
  const cachedOptions = await getCachedTransit(cacheKey);
  if (cachedOptions && cachedOptions.length > 0) {
    // Re-score cached options in case hourlyRateUsd or activeVouchers changed
    const scoredCached = recalculateOptionsWithVttsAndVouchers(
      cachedOptions,
      hourlyRateUsd,
      activeVouchers,
      travelerProfile
    );
    return {
      cacheKey,
      source: 'redis_cache',
      cached: true,
      ttlSeconds: REDIS_CACHE_TTL_SECONDS,
      options: withBookingUrls(scoredCached),
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

  // 4. Store in Redis with 12-hour TTL (EX: 43200)
  await setCachedTransit(cacheKey, finalOptions);

  return {
    cacheKey,
    source,
    cached: false,
    ttlSeconds: REDIS_CACHE_TTL_SECONDS,
    options: withBookingUrls(finalOptions),
  };
}
