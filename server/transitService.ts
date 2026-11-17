// MUST stay the first import so env is loaded before the Redis/SerpApi clients are configured
import { getEnv, useRealData, warnMissingKey } from './env.ts';
import { getRedisClient } from './redis.ts';
import { searchDuffelOffers } from './duffelService.ts';
import { fetchUlccFallback } from './ulccService.ts';
import { getRates } from './ratesService.ts';
import { toUsd } from '../shared/pricing.ts';
import type { SliceRequest } from '../shared/flights.ts';
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

export { checkRedisConnection, getRedisClient, isRedisConfigured } from './redis.ts';

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

/**
 * Live, bookable flights from Duffel for one corridor, one-way or round trip, as scored options
 * (`source: 'duffel'`). Prices are per traveller (one adult is asked, the UI scales by party size) and
 * already include our service fee. Null when Duffel is not configured or failed; an empty list when
 * it answered with nothing.
 */
async function fetchDuffelFlights(
  origin: string,
  destination: string,
  date: string,
  hourlyRateUsd: number,
  profile: Partial<TravelerProfile> | undefined,
  fromStop?: TripStop,
  toStop?: TripStop,
  returnDate?: string
): Promise<{ options: TransitOption[]; cached: boolean } | null> {
  const from = origin.trim().toUpperCase();
  const to = destination.trim().toUpperCase();
  const slices: SliceRequest[] = [
    { origin: from, destination: to, departureDate: date },
    ...(returnDate ? [{ origin: to, destination: from, departureDate: returnDate }] : []),
  ];
  const found = await searchDuffelOffers({ slices, passengers: 1 });
  if (!found) return null;
  if (found.offers.length === 0) return { options: [], cached: found.cached };

  const rates = (await getRates()).rates;
  const fromPoint = resolveCityCoords(origin, fromStop);
  const toPoint = resolveCityCoords(destination, toStop);
  const distanceKm = haversineDistanceKm(fromPoint.lat, fromPoint.lng, toPoint.lat, toPoint.lng);
  const legId = `leg-${origin.toLowerCase()}-${destination.toLowerCase()}`;
  const stamp = (iso: string) => iso.slice(0, 16).replace('T', ' '); // "2026-11-21 19:45"
  const dayDiff = (a: string, b: string) =>
    Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000);

  // Cheapest first, but never lose the cheapest nonstop to a pile of cheap connections
  const byPrice = [...found.offers].sort((a, b) => a.pricing.displayTotal - b.pricing.displayTotal);
  const picked = byPrice.slice(0, 6);
  const nonstop = byPrice.find((o) => o.slices[0].segments.length === 1);
  if (nonstop && !picked.includes(nonstop)) picked.push(nonstop);

  const rawOptions: TransitOption[] = [];
  let skipped = 0;
  picked.forEach((offer, idx) => {
    const out = offer.slices[0];
    const priceUsd = round2(toUsd(offer.pricing.displayTotal, offer.pricing.currency, rates) ?? 0);
    const hopAirports = out.segments.map((s) => ({
      from: resolveAirportCoords(s.origin.iataCode || origin),
      to: resolveAirportCoords(s.destination.iataCode || destination),
    }));
    // A hop whose airport no dataset knows cannot be drawn truthfully: drop the fare rather than
    // give it a line to an invented point.
    if (!(priceUsd > 0) || hopAirports.some((h) => !h.from || !h.to)) {
      skipped++;
      return;
    }

    const layoverMinutes = out.layovers.reduce((sum, l) => sum + l.minutes, 0);
    const inVehicleMinutes = Math.max(1, out.durationMinutes - layoverMinutes);
    const inVehicleHours = round2(inVehicleMinutes / 60);
    const layoverHours = round2(layoverMinutes / 60);
    const flightNumbers = out.segments.map((s) => s.flightNumber);
    const carriers = Array.from(new Set(out.segments.map((s) => s.carrier.name).filter(Boolean)));
    const carrierCode = (offer.owner.iataCode || out.segments[0].carrier.iataCode).toUpperCase();
    const depTime = out.departureAt.slice(11, 16);
    const offset = dayDiff(out.departureAt, out.arrivalAt);
    const arrTime = `${out.arrivalAt.slice(11, 16)}${offset > 0 ? ` +${offset}d` : ''}`;

    const segments: TransitSegment[] = out.segments.map((s, i) => ({
      id: `${legId}-duffel-${idx + 1}-s${i + 1}`,
      mode: 'flight' as TransitMode,
      label: s.flightNumber,
      fromName: s.origin.name || hopAirports[i].from!.code,
      fromCode: hopAirports[i].from!.code,
      fromLat: hopAirports[i].from!.lat,
      fromLng: hopAirports[i].from!.lng,
      toName: s.destination.name || hopAirports[i].to!.code,
      toCode: hopAirports[i].to!.code,
      toLat: hopAirports[i].to!.lat,
      toLng: hopAirports[i].to!.lng,
      durationMinutes: s.durationMinutes || Math.round(inVehicleMinutes / out.segments.length),
    }));
    const hops: FlightHop[] = out.segments.map((s, i) => ({
      flightNumber: s.flightNumber,
      airline: s.carrier.name,
      airlineLogo: s.carrier.logoUrl,
      airplane: s.aircraft,
      fromCode: segments[i].fromCode,
      fromName: s.origin.name,
      departureAt: stamp(s.departureAt),
      toCode: segments[i].toCode,
      toName: s.destination.name,
      arrivalAt: stamp(s.arrivalAt),
      durationMinutes: s.durationMinutes,
    }));
    const layoverInfo: Layover[] = out.layovers.map((l) => ({
      code: l.airport.iataCode,
      name: l.airport.name,
      minutes: l.minutes,
      overnight: l.overnight,
    }));

    const scorable = {
      ticketType: returnDate ? ('return' as const) : undefined,
      departureTime: depTime,
      arrivalTime: arrTime,
      stopsCount: out.layovers.length,
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

    rawOptions.push({
      id: `${legId}-duffel${returnDate ? '-rt' : ''}-${idx + 1}`,
      legId,
      mode: 'flight',
      isOvernightSleeper: false,
      carrier: carriers.join(' + ') || offer.owner.name,
      carrierCode,
      routeCode: flightNumbers.join(' + ') || `${originCode}-${destCode}`,
      flightNumbers,
      carriers,
      originStation: out.origin.name || `${originCode} Airport`,
      destinationStation: out.destination.name || `${destCode} Airport`,
      departureTime: depTime,
      arrivalTime: arrTime,
      departureAt: stamp(out.departureAt),
      arrivalAt: stamp(out.arrivalAt),
      inVehicleHours,
      layoverHours,
      layoverHub: out.layovers[0]?.airport.iataCode || undefined,
      stopsCount: out.layovers.length,
      basePriceUsd: priceUsd,
      smartScore: breakdown.totalSmartScore,
      smartScoreBreakdown: breakdown,
      doorToDoorNotes: `${originCode} (${depTime || '--:--'}) → ${destCode} (${arrTime || '--:--'})`,
      co2Kg: Math.round(distanceKm * 0.12),
      segments,
      dataSource: 'live',
      ticketType: returnDate ? 'return' : undefined,
      returnDate,
      airlineLogo: offer.owner.logoUrl,
      hops,
      layovers: layoverInfo,
      source: 'duffel',
      offerId: offer.offerId,
      expiresAt: offer.expiresAt,
      pricing: offer.pricing,
      checkout: { slices, ...(offer.cabinClass ? { cabinClass: offer.cabinClass } : {}) },
    });
  });
  if (skipped > 0) {
    console.warn(`[Transit API] Skipped ${skipped} Duffel offer(s) with no usable price or an unknown airport.`);
  }
  if (rawOptions.length === 0) return { options: [], cached: found.cached };
  console.log(`[Transit API] ${rawOptions.length} live Duffel flights${found.cached ? ' (cached)' : ''}.`);
  return { options: recalculateOptions(rawOptions, hourlyRateUsd, profile), cached: found.cached };
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
 *   1. FLIGHTS: live Duffel offers (cached 10 min, offers near expiry never served) plus ULCC fares
 *      from the Aviasales data. No token / no results → curated or estimated flights, labelled as such.
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

  // 1. Live flights from Duffel (each search is cached 10 minutes, and offers near expiry are not
  //    served), plus ULCC fares Duffel does not sell. Skipped entirely in sample-data mode
  //    (USE_REAL_DATA off): no Duffel request, so nothing is searched or spent.
  let live: TransitOption[] | null = null;
  let cacheLayer = null as 'memory' | 'redis' | null;
  if (useRealData() && (mode === 'all' || mode === 'flight')) {
    const duffelResult = await fetchDuffelFlights(
      origin,
      destination,
      date,
      hourlyRateUsd,
      travelerProfile,
      fromStop,
      toStop,
      returnDate
    );
    const ulcc = await fetchUlccFallback({
      origin,
      destination,
      date,
      returnDate,
      legId: `leg-${origin.toLowerCase()}-${destination.toLowerCase()}`,
      hourlyRateUsd,
      profile: travelerProfile,
    });
    const combined = [...(duffelResult?.options ?? []), ...ulcc];
    if (combined.length > 0) {
      live = combined;
      cacheLayer = duffelResult?.cached && ulcc.length === 0 ? 'redis' : null;
    }
  }

  // 1b. Sample mode: real recent fares from the free Aviasales Data API instead of invented ones
  //     (no SerpApi credits involved). Cached 12 h; routes it has no data for keep the sample flights.
  let recentFares = false;
  if (!useRealData() && (mode === 'all' || mode === 'flight') && travelpayoutsToken()) {
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
