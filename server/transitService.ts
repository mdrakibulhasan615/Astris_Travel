// MUST stay the first import so env is loaded before the Redis/SerpApi clients are configured
import { getEnv, useRealData, warnMissingKey } from './env.ts';
import { Redis } from '@upstash/redis';
import {
  CURATED_CORRIDOR_OPTIONS,
  DESTINATION_HUBS,
} from '../shared/mockDataset.ts';
import { AFFILIATE_DEFAULTS } from '../shared/config.ts';
import { attachBookingUrls, configureAffiliate, isFlixCarrier } from '../shared/affiliate.ts';
import {
  airportsForCity,
  normalizeOptionGeometry,
  registerAirportResolver,
  resolveAirport,
} from '../shared/airports.ts';
import { isIsoDate } from '../shared/fares.ts';
import { parseBaggage } from '../shared/ticketDetails.ts';
import {
  computeSmartScore,
  deriveReturnOptions,
  haversineDistanceKm,
  recalculateOptions,
  round2,
  synthesizeCorridorOptions,
} from '../shared/smartScore.ts';
import type { LiveFlightOffer } from '../shared/liveFlights.ts';
import type {
  FlightHop,
  Layover,
  TransitMode,
  TransitOption,
  TransitSegment,
  TravelerProfile,
  TripStop,
} from '../shared/types.ts';
import { getAirportByIata } from './airportService.ts';
import { resolveFlixbusRoute } from './flixbusService.ts';
import { fetchTravelpayoutsFlights, travelpayoutsToken } from './travelpayoutsService.ts';

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
  tripcomAllianceId:
    getEnv('TRIPCOM_ALLIANCE_ID') ?? getEnv('VITE_TRIP_ALLIANCE_ID') ?? AFFILIATE_DEFAULTS.tripcomAllianceId,
  tripcomSid: getEnv('TRIPCOM_SID') ?? getEnv('VITE_TRIP_SID') ?? AFFILIATE_DEFAULTS.tripcomSid,
  tripcomSub3: getEnv('TRIPCOM_SUB3') ?? AFFILIATE_DEFAULTS.tripcomSub3,
  bookingAid: getEnv('BOOKING_AID'),
  agodaCid: getEnv('AGODA_CID'),
  twelveGoAffiliateId: getEnv('TWELVEGO_AFFILIATE_ID') ?? AFFILIATE_DEFAULTS.twelveGoAffiliateId,
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
 * transit:cache:${origin}:${destination}:${date}:${mode}[:rt:${returnDate}]
 * A return search is a different query (and price) from a one-way search, so it has its own key.
 */
export function buildTransitCacheKey(
  origin: string,
  destination: string,
  date: string,
  mode: string = 'all',
  returnDate?: string
): string {
  const normOrigin = (origin || 'UNKNOWN').trim().toUpperCase();
  const normDest = (destination || 'UNKNOWN').trim().toUpperCase();
  const normDate = (date || 'ANY').trim();
  const normMode = (mode || 'all').trim().toLowerCase();
  const suffix = returnDate ? `:rt:${returnDate.trim()}` : '';
  return `transit:cache:${normOrigin}:${normDest}:${normDate}:${normMode}${suffix}`;
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
  /** Way-back date: asks for return fares (priced for the round trip) instead of one-way. */
  returnDate?: string;
  mode?: 'all' | TransitMode;
  hourlyRateUsd?: number;
  travelerProfile?: Partial<TravelerProfile>;
  passengers?: number;
  fromStop?: TripStop;
  toStop?: TripStop;
}

export interface TransitQueryResult {
  cacheKey: string;
  source: 'redis_cache' | 'memory_cache' | 'live_api' | 'recent_fares' | 'fallback_corridor';
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

export interface LiveOptionsContext {
  origin: string;
  destination: string;
  /** Departure date of the leg, `YYYY-MM-DD`. */
  date: string;
  returnDate?: string;
  hourlyRateUsd: number;
  profile?: Partial<TravelerProfile>;
  fromStop?: TripStop;
  toStop?: TripStop;
  passengers?: number;
  /** USD per unit of the offers' currency (1 for USD). */
  usdPerUnit?: number;
}

/**
 * Live fares (fetched on request, see `server/liveFlightsApi.ts`) as scored ticket options. Every
 * field comes from the provider's answer; an offer with an airport no dataset knows cannot be drawn
 * truthfully and is dropped. Merchant comparison rows are not attached: a live ticket is bought
 * through its own seller list ("Book Exact Ticket").
 */
export function liveOffersToOptions(offers: LiveFlightOffer[], ctx: LiveOptionsContext): TransitOption[] {
  const { origin, destination, returnDate, hourlyRateUsd, profile } = ctx;
  const usdPerUnit = ctx.usdPerUnit ?? 1;
  const fromCity = resolveCityCoords(origin, ctx.fromStop);
  const toCity = resolveCityCoords(destination, ctx.toStop);
  const distanceKm = haversineDistanceKm(fromCity.lat, fromCity.lng, toCity.lat, toCity.lng);
  const legId = `leg-${origin.toLowerCase()}-${destination.toLowerCase()}`;
  const dayDiff = (a: string, b: string) =>
    Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000);

  const options: TransitOption[] = [];
  let skipped = 0;
  for (const offer of offers) {
    const hopAirports = offer.segments.map((s) => ({ from: resolveAirportCoords(s.fromIata), to: resolveAirportCoords(s.toIata) }));
    const priceUsd = round2(offer.price * usdPerUnit);
    if (!(priceUsd > 0) || hopAirports.some((h) => !h.from || !h.to)) {
      skipped++;
      continue;
    }
    const first = offer.segments[0];
    const last = offer.segments[offer.segments.length - 1];
    const layoverMinutes = offer.layovers.reduce((sum, l) => sum + l.durationMinutes, 0);
    const inVehicleMinutes =
      offer.totalDurationMinutes - layoverMinutes > 0
        ? offer.totalDurationMinutes - layoverMinutes
        : offer.segments.reduce((sum, s) => sum + s.durationMinutes, 0);
    if (!(inVehicleMinutes > 0)) {
      skipped++;
      continue;
    }
    const inVehicleHours = round2(inVehicleMinutes / 60);
    const layoverHours = round2(layoverMinutes / 60);
    const flightNumbers = offer.segments.map((s) => s.flightNumber).filter(Boolean);
    const carriers = Array.from(new Set(offer.segments.map((s) => s.airline).filter(Boolean)));
    const carrierCode = (offer.airline.iataCode || carriers[0]?.slice(0, 2) || '').toUpperCase();
    const depTime = first.departureAt.slice(11, 16);
    const offset = dayDiff(first.departureAt, last.arrivalAt);
    const arrTime = `${last.arrivalAt.slice(11, 16)}${offset > 0 ? ` +${offset}d` : ''}`;

    const segments: TransitSegment[] = offer.segments.map((s, i) => ({
      id: `${legId}-live-${offer.id}-s${i + 1}`,
      mode: 'flight' as TransitMode,
      label: s.flightNumber || `Flight ${i + 1}`,
      fromName: s.fromName || hopAirports[i].from!.code,
      fromCode: hopAirports[i].from!.code,
      fromLat: hopAirports[i].from!.lat,
      fromLng: hopAirports[i].from!.lng,
      toName: s.toName || hopAirports[i].to!.code,
      toCode: hopAirports[i].to!.code,
      toLat: hopAirports[i].to!.lat,
      toLng: hopAirports[i].to!.lng,
      durationMinutes: s.durationMinutes || Math.round(inVehicleMinutes / offer.segments.length),
    }));
    const hops: FlightHop[] = offer.segments.map((s, i) => ({
      flightNumber: s.flightNumber,
      airline: s.airline,
      airlineLogo: s.airlineLogo,
      airplane: s.airplane,
      travelClass: s.travelClass,
      fromCode: segments[i].fromCode,
      fromName: s.fromName,
      departureAt: s.departureAt,
      toCode: segments[i].toCode,
      toName: s.toName,
      arrivalAt: s.arrivalAt,
      durationMinutes: s.durationMinutes,
    }));
    const layoverInfo: Layover[] = offer.layovers.map((l) => ({
      code: l.iata,
      name: l.airportName,
      minutes: l.durationMinutes,
      overnight: l.overnight,
    }));

    const scorable = {
      ticketType: returnDate ? ('return' as const) : undefined,
      departureTime: depTime,
      arrivalTime: arrTime,
      stopsCount: offer.stopsCount,
      segments,
      basePriceUsd: priceUsd,
      inVehicleHours,
      layoverHours,
      isOvernightSleeper: false,
      mode: 'flight' as TransitMode,
      carrierCode,
    };
    const breakdown = computeSmartScore(scorable, hourlyRateUsd, profile);
    const originCode = segments[0].fromCode;
    const destCode = segments[segments.length - 1].toCode;

    options.push({
      id: `${legId}-live-${offer.id}`,
      legId,
      mode: 'flight',
      isOvernightSleeper: false,
      carrier: carriers.join(' + ') || offer.airline.name,
      carrierCode,
      routeCode: flightNumbers.join(' + ') || `${originCode}-${destCode}`,
      flightNumbers,
      carriers,
      originStation: first.fromName || `${originCode} Airport`,
      destinationStation: last.toName || `${destCode} Airport`,
      departureTime: depTime,
      arrivalTime: arrTime,
      departureAt: first.departureAt,
      arrivalAt: last.arrivalAt,
      inVehicleHours,
      layoverHours,
      layoverHub: offer.layovers[0]?.iata || undefined,
      stopsCount: offer.stopsCount,
      basePriceUsd: priceUsd,
      smartScore: breakdown.totalSmartScore,
      smartScoreBreakdown: breakdown,
      doorToDoorNotes: `${originCode} (${depTime || '--:--'}) → ${destCode} (${arrTime || '--:--'})`,
      co2Kg: offer.co2Kg ?? Math.round(distanceKm * 0.12),
      segments,
      dataSource: 'live',
      ticketType: returnDate ? 'return' : undefined,
      returnDate,
      airlineLogo: offer.airline.logo,
      baggage: offer.baggage,
      hops,
      layovers: layoverInfo,
      source: 'serpapi_live',
      liveOfferId: offer.id,
      bookingToken: offer.bookingToken,
      departureToken: offer.departureToken,
      liveSearch: { originIata: origin, destinationIata: destination, departureDate: ctx.date, returnDate },
      fetchedAt: offer.fetchedAt,
      baggageSummary: offer.baggageSummary,
    });
  }
  if (skipped > 0) {
    console.warn(`[Live Flights] Skipped ${skipped} offer(s) with no usable price or an unknown airport.`);
  }

  const scored = recalculateOptions(options, hourlyRateUsd, profile);
  const cityPoint = (code: string, c: { lat: number; lng: number; city: string }) => ({
    city: c.city,
    iataCode: code.trim().toUpperCase(),
    lat: c.lat,
    lng: c.lng,
  });
  return attachBookingUrls(
    scored.map((o) => normalizeOptionGeometry(o, cityPoint(origin, fromCity), cityPoint(destination, toCity))),
    {
      fromCode: origin.trim().toUpperCase(),
      toCode: destination.trim().toUpperCase(),
      fromCity: fromCity.city,
      toCity: toCity.city,
      date: ctx.date,
      returnDate,
      passengers: ctx.passengers,
    }
  );
}

/**
 * Builds fallback options from curated corridor dataset or synthetic corridor engine.
 */
function buildFallbackCorridorOptions(
  origin: string,
  destination: string,
  hourlyRateUsd: number,
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
      hourlyRateUsd,
      profile
    );
  }

  return recalculateOptions(baseOptions, hourlyRateUsd, profile);
}

/**
 * Transit query pipeline for one corridor, one-way or return:
 *   1. FLIGHTS: live SerpApi fares (cached 12 h in Redis + memory; only live results are cached).
 *      No key / no results → curated or estimated flights, labelled as such.
 *   2. GROUND (train, coach, ferry): there is no live availability API for these, so they are the
 *      curated/estimated options, labelled Sample/Estimate, with a direct merchant link per option.
 *      They are rebuilt every time and never cached.
 *   3. RETURN: live flights are real round-trip fares (priced for both directions). Ground (and flights
 *      when no live return fare exists) are the one-way price twice, flagged as estimates.
 * Failures at any step degrade to the next; nothing here throws for a provider error.
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
    travelerProfile,
    passengers,
    fromStop,
    toStop,
  } = params;
  // A return date before the outbound date is meaningless; fall back to a one-way search
  const returnDate =
    isIsoDate(params.returnDate) && params.returnDate >= date ? params.returnDate : undefined;

  // Booking links are (re)built on every response — cached options may pre-date the current
  // affiliate ids, travel date, or route naming.
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
        returnDate,
        passengers,
        flixbus,
      }
    );
  };

  const cacheKey = buildTransitCacheKey(origin, destination, date, mode, returnDate);

  // Curated / estimated options: always rebuilt (cheap), split so live flights can replace flights only
  const fallback =
    mode === 'all' || mode === 'flight' || mode === 'train' || mode === 'bus' || mode === 'ferry'
      ? buildFallbackCorridorOptions(
          origin,
          destination,
          hourlyRateUsd,
              travelerProfile,
          fromStop,
          toStop
        )
      : [];
  const fallbackFlights = fallback.filter((o) => o.mode === 'flight');
  const fallbackGround = fallback.filter((o) => o.mode !== 'flight');

  // 1. Live fares are NEVER fetched here: a SerpApi search costs one of a small monthly allowance, so
  //    they are fetched only when the traveller presses "Fetch Live Fares" (server/liveFlightsApi.ts).
  //    The list starts as curated/estimated flights, or recent real fares when TRAVELPAYOUTS_TOKEN is set.
  let live: TransitOption[] | null = null;
  const cacheLayer = null as 'memory' | 'redis' | null;

  // 1b. Sample mode: real recent fares from the free Aviasales Data API instead of invented ones
  //     (no SerpApi credits involved). Cached 12 h; routes it has no data for keep the sample flights.
  let recentFares = false;
  if ((mode === 'all' || mode === 'flight') && travelpayoutsToken()) {
    const tpKey = `${cacheKey}:tp2`;
    const hit = await getCachedTransit(tpKey);
    let tp: TransitOption[] | null = hit && hit.options.length > 0 ? hit.options : null;
    if (!tp) {
      tp = await fetchTravelpayoutsFlights({
        origin,
        destination,
        date,
        returnDate,
        legId: `leg-${origin.toLowerCase()}-${destination.toLowerCase()}`,
        hourlyRateUsd,
          profile: travelerProfile,
      });
      if (tp && tp.length > 0) await setCachedTransit(tpKey, tp);
    }
    if (tp && tp.length > 0) {
      live = tp;
      recentFares = true;
    }
  }
  const hasLiveFlights = Boolean(live && live.length > 0);

  // 2./3. Assemble the list for this ticket type
  let assembled: TransitOption[];
  if (!returnDate) {
    assembled = [...(hasLiveFlights ? live! : fallbackFlights), ...fallbackGround];
  } else {
    const derive = (opts: TransitOption[]) =>
      deriveReturnOptions(opts, returnDate, hourlyRateUsd, travelerProfile);
    assembled = [
      ...(hasLiveFlights ? live! : derive(fallbackFlights)),
      ...derive(fallbackGround),
    ];
  }

  // Re-score in case the hourly rate changed since a cached search was made
  let finalOptions = recalculateOptions(
    assembled,
    hourlyRateUsd,
    travelerProfile
  );
  if (mode !== 'all') {
    const filtered = finalOptions.filter((opt) => opt.mode === mode);
    if (filtered.length > 0) finalOptions = filtered;
  }

  const source: TransitQueryResult['source'] = !hasLiveFlights
    ? 'fallback_corridor'
    : recentFares
      ? 'recent_fares'
      : cacheLayer === 'memory'
      ? 'memory_cache'
      : cacheLayer === 'redis'
        ? 'redis_cache'
        : 'live_api';

  return {
    cacheKey,
    source,
    cached: cacheLayer !== null,
    ttlSeconds: REDIS_CACHE_TTL_SECONDS,
    options: await withBookingUrls(finalOptions),
  };
}
