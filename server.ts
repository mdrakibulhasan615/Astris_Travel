// MUST stay the first import: loads .env.local / .env before any service reads process.env
import { logEnvStatus, useRealData } from './server/env.ts';
import { getRates } from './server/ratesService.ts';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REDIS_CACHE_TTL_SECONDS,
  buildTransitCacheKey,
  checkRedisConnection,
  isRedisConfigured,
  queryTransitWithCache,
} from './server/transitService.ts';
import { searchAirports } from './server/airportService.ts';
import {
  CURATED_CORRIDOR_OPTIONS,
  DESTINATION_HUBS,
  createDefaultTrip,
} from './shared/mockDataset.ts';
import {
  buildLegIds,
  buildLegsFromStops,
  haversineDistanceKm,
  isSamePlace,
  round2,
  sanitizeHourlyRate,
} from './shared/smartScore.ts';
import { getPublicAffiliateConfig } from './shared/affiliate.ts';
import { fetchGoogleTransitRoutes, googleMapsKey } from './server/googleRoutesService.ts';
import { fetchTwelveGoTimetable, twelveGoCountry } from './server/twelveGoService.ts';
import { fetchHotels, serpApiHotelsKey } from './server/hotelService.ts';
import { registerDuffelWebhook, registerFlightRoutes } from './server/flightsApi.ts';
import { isDuffelConfigured } from './server/duffelService.ts';
import type { GroundSchedules } from './shared/groundSchedule.ts';
import {
  finalizeLegs,
  isIsoDate,
  legFareKey,
  legReturnDate,
  legTotals,
  pairStops,
  wantsReturnFares,
} from './shared/fares.ts';
import type {
  LegTicketPref,
  OptimizationCandidate,
  RouteOptimizationResult,
  TransitMode,
  TravelerProfile,
  TripLeg,
  TripStop,
} from './shared/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

/** Accepts only known profile keys with sane types; everything else is dropped. */
function sanitizeProfile(raw: unknown): Partial<TravelerProfile> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: Partial<TravelerProfile> = {};
  if (r.priceWeight !== undefined && Number.isFinite(Number(r.priceWeight))) out.priceWeight = Number(r.priceWeight);
  if (r.timeWeight !== undefined && Number.isFinite(Number(r.timeWeight))) out.timeWeight = Number(r.timeWeight);
  if (r.allowRedEyes !== undefined) out.allowRedEyes = r.allowRedEyes === true || r.allowRedEyes === 'true';
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Accepts `{ legId: { type: 'one-way' | 'return', returnDate? } }`; anything else is dropped. */
function sanitizeLegPrefs(raw: unknown): Record<string, LegTicketPref> {
  const out: Record<string, LegTicketPref> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [legId, value] of Object.entries(raw as Record<string, unknown>).slice(0, 50)) {
    const v = value as { type?: unknown; returnDate?: unknown } | null;
    if (!v || (v.type !== 'one-way' && v.type !== 'return')) continue;
    out[legId.slice(0, 80)] = {
      type: v.type,
      ...(isIsoDate(v.returnDate) ? { returnDate: v.returnDate } : {}),
    };
  }
  return out;
}

function getPermutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const current = items[i];
    const remaining = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of getPermutations(remaining)) {
      result.push([current, ...perm]);
    }
  }
  return result;
}

function computeTotalDistance(stops: TripStop[]): number {
  let total = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    total += haversineDistanceKm(
      stops[i].lat,
      stops[i].lng,
      stops[i + 1].lat,
      stops[i + 1].lng
    );
  }
  return total;
}

function summarizeLegs(legs: TripLeg[]) {
  let totalCostUsd = 0;
  let totalHours = 0;
  let totalSmartScore = 0;
  let totalDistanceKm = 0;

  for (const leg of legs) {
    totalDistanceKm += leg.distanceKm;
    // A return ticket's price and score are counted once, on the leg that carries it
    const t = legTotals(leg);
    totalCostUsd += t.costUsd;
    totalHours += t.hours;
    totalSmartScore += t.score;
  }

  return {
    totalDistanceKm,
    totalCostUsd: round2(totalCostUsd),
    totalHours: round2(totalHours),
    totalSmartScore: round2(totalSmartScore),
  };
}

interface LegBuildOptions {
  hourlyRate: number;
  profile?: Partial<TravelerProfile>;
  passengers: number;
  previousSelectedMap?: Record<string, string>;
  /** Ticket types the traveller chose, by leg id. */
  legPrefs?: Record<string, LegTicketPref>;
}

/**
 * Builds every leg through the transit service (live SerpApi → cache → curated/synthesized
 * fallback). This is the single place legs are produced for the API, so the initial page load and
 * later recomputes show the same data. Option objects are passed through unchanged apart from
 * scoring, geometry normalisation and booking links.
 */
async function buildLegsViaTransitService(
  stops: TripStop[],
  opts: LegBuildOptions
): Promise<TripLeg[]> {
  const { hourlyRate, profile, passengers, previousSelectedMap, legPrefs } = opts;
  const legIds = buildLegIds(stops);
  // A later leg that comes back (A to B ... B to A) makes a return ticket worth pricing
  const pairs = pairStops(stops);

  const legPromises = stops.slice(0, -1).map(async (fromStop, i): Promise<TripLeg | undefined> => {
    const toStop = stops[i + 1];
    const legId = legIds[i];
    const distanceKm = haversineDistanceKm(fromStop.lat, fromStop.lng, toStop.lat, toStop.lng);
    const prevSelected = previousSelectedMap?.[legId];
    const pref = legPrefs?.[legId];
    const returnDate = legReturnDate(stops, i, pairs, pref);
    const base = {
      id: legId,
      fromStopId: fromStop.id,
      toStopId: toStop.id,
      fromCity: fromStop.city,
      fromCode: fromStop.iataCode,
      toCity: toStop.city,
      toCode: toStop.iataCode,
      distanceKm,
      departureDate: fromStop.departureDate,
      returnDate,
      pairedLegId: pairs[i] !== undefined ? legIds[pairs[i]] : undefined,
      fareKey: legFareKey(fromStop, toStop, passengers),
    };

    // The same city twice in a row needs no transport (and must not hit the flight API)
    if (isSamePlace(fromStop, toStop)) {
      return { ...base, selectedOptionId: '', transitOptions: [], oneWayOptions: [] };
    }

    try {
      const query = (ret?: string) =>
        queryTransitWithCache({
          origin: fromStop.iataCode,
          destination: toStop.iataCode,
          date: fromStop.departureDate,
          returnDate: ret,
          mode: 'all',
          hourlyRateUsd: hourlyRate,
          travelerProfile: profile,
          passengers,
          fromStop,
          toStop,
        });
      // Return fares are only fetched when they matter (a paired leg, or the traveller chose one):
      // every extra search is one more provider call against the rate limit.
      const [oneWayResult, returnResult] = await Promise.all([
        query(),
        wantsReturnFares(i, pairs, pref)
          ? query(returnDate).catch((err) => {
              console.warn(`[Flight Data] ${legId}: return fare search failed:`, err);
              return null;
            })
          : Promise.resolve(null),
      ]);
      const oneWay = oneWayResult.options.map((o) => ({ ...o, legId }));
      const returnOptions = returnResult?.options.map((o) => ({ ...o, legId }));
      console.log(
        `[Flight Data] ${legId}: ${oneWay.length} options from ${oneWayResult.source}` +
          ` (${oneWay.filter((o) => o.dataSource === 'live').length} live)` +
          (returnOptions
            ? `, ${returnOptions.length} return options (${
                returnOptions.filter((o) => o.dataSource === 'live').length
              } live) back ${returnDate}`
            : '')
      );
      return {
        ...base,
        selectedOptionId: oneWay.some((o) => o.id === prevSelected)
          ? prevSelected!
          : (oneWay[0]?.id ?? ''),
        transitOptions: oneWay,
        oneWayOptions: oneWay,
        returnOptions,
      };
    } catch (err) {
      console.warn(
        `[Flight Data] ${legId}: transit query failed, using curated/synthesized SAMPLE data:`,
        err
      );
      const fallback = buildLegsFromStops(
        [fromStop, toStop],
        CURATED_CORRIDOR_OPTIONS,
        hourlyRate,
        undefined,
        { profile, passengers }
      )[0];
      if (!fallback) return undefined;
      // A 2-stop rebuild always yields the base id; restore this leg's (possibly suffixed) id
      return {
        ...fallback,
        ...base,
        selectedOptionId: fallback.transitOptions.some((o) => o.id === prevSelected)
          ? prevSelected!
          : fallback.selectedOptionId,
      };
    }
  });

  const legs = (await Promise.all(legPromises)).filter((l): l is TripLeg => Boolean(l));
  // Settle each leg's ticket structure now that every leg's fares are known
  return finalizeLegs(legs, legPrefs);
}

/** Development log of exactly what the API is about to send, for comparison with the browser log. */
function logLegs(label: string, legs: TripLeg[]): void {
  if (process.env.NODE_ENV === 'production') return;
  for (const leg of legs) {
    const o = leg.transitOptions.find((x) => x.id === leg.selectedOptionId) ?? leg.transitOptions[0];
    if (!o) {
      console.log(`[Flight Data] ${label} ${leg.id}: no options`);
      continue;
    }
    console.log(
      `[Flight Data] ${label} ${leg.id} selected=${o.id} src=${o.dataSource ?? '?'} | ` +
        `${o.carrier} ${o.routeCode} | ${o.departureTime || '--:--'} → ${o.arrivalTime || '--:--'} | ` +
        `${o.inVehicleHours}h+${o.layoverHours}h layover | $${o.basePriceUsd}`
    );
  }
}

/**
 * The API without any hosting concerns: no Vite, no static files, no listen(). `api/index.ts`
 * exports this for Vercel; `startServer` below wraps it for local dev and self-hosting.
 */
export function createApp() {
  logEnvStatus();
  const app = express();
  // The Duffel webhook needs the raw body for its signature, so it goes before the JSON parser
  registerDuffelWebhook(app);
  app.use(express.json());
  registerFlightRoutes(app);

  // Health & initial dataset
  // The initial trip used to be pure mock data (TK 61 etc.), so live SerpApi fares only appeared
  // after the first edit. It now runs through the same pipeline as /api/legs/recompute, with a
  // time budget so a slow provider can't block the page (falls back to the labelled sample data).
  app.get('/api/trips/default', async (_req, res) => {
    const trip = createDefaultTrip();
    try {
      const legs = await Promise.race([
        buildLegsViaTransitService(trip.stops, {
          hourlyRate: trip.hourlyTimeValue,
          passengers: trip.travelers,
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 9000)),
      ]);
      if (legs && legs.length === trip.legs.length) {
        trip.legs = legs;
      } else {
        console.warn('[Flight Data] default trip: live pipeline timed out, serving SAMPLE data.');
      }
    } catch (err) {
      console.warn('[Flight Data] default trip: live pipeline failed, serving SAMPLE data:', err);
    }
    logLegs('default-trip', trip.legs);
    res.json(trip);
  });

  app.get('/api/destinations', (_req, res) => {
    res.json({ destinations: searchAirports('', 20) });
  });

  // Global Airport Autocomplete Search (6,300+ global airports via 'airports' package)
  app.get('/api/airports/search', (req, res) => {
    const q = String(req.query.q || '').trim();
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 15)));
    const results = searchAirports(q, limit);
    res.json({ query: q, count: results.length, results });
  });

  // Whether fares are live or sample data (read-only; the switch lives in code/env, not the UI)
  app.get('/api/config', (_req, res) => {
    res.json({ dataMode: useRealData() && isDuffelConfigured() ? 'live' : 'mock' });
  });

  // Exchange rates for the currency switcher (12 h cache, fallback table on failure)
  app.get('/api/rates', async (_req, res) => {
    try {
      res.json(await getRates());
    } catch (err) {
      console.warn('[Rates API] Error:', err);
      res.status(500).json({ error: 'Exchange rates unavailable' });
    }
  });

  // Partner ids for the browser's link builders (stays, optimistic transport links). These are
  // public by nature: every outbound link already carries them.
  app.get('/api/affiliate/config', (_req, res) => {
    res.json(getPublicAffiliateConfig());
  });

  // Upstash Redis Cache Health & Status Endpoint
  app.get('/api/transit/cache/status', async (_req, res) => {
    const configured = isRedisConfigured();
    const connected = configured ? await checkRedisConnection() : false;
    res.json({
      status: 'ok',
      redisConfigured: configured,
      redisConnected: connected,
      ttlSeconds: REDIS_CACHE_TTL_SECONDS,
      provider: 'Upstash Redis',
      fallbackMode: !connected,
    });
  });

  // Live hotels for one stop (Google Hotels via SerpApi). Only in live-data mode: a search costs a
  // credit, so sample mode answers `enabled: false` without calling out. Cached 24 hours.
  app.get('/api/hotels/search', async (req, res) => {
    try {
      const enabled = useRealData() && Boolean(serpApiHotelsKey());
      if (!enabled) return res.json({ enabled: false, hotels: [] });
      const city = String(req.query.city ?? '').trim().slice(0, 80);
      const country = String(req.query.country ?? '').trim().slice(0, 80);
      const checkIn = String(req.query.checkIn ?? '');
      const checkOut = String(req.query.checkOut ?? '');
      const iso = /^\d{4}-\d{2}-\d{2}$/;
      if (!city || !iso.test(checkIn) || !iso.test(checkOut) || checkOut <= checkIn) {
        return res.status(400).json({ error: 'city, checkIn and a later checkOut (YYYY-MM-DD) are required.' });
      }
      const adults = Math.min(9, Math.max(1, Math.floor(Number(req.query.adults)) || 2));
      const result = await fetchHotels({ city, country, checkIn, checkOut, adults });
      res.json({ enabled: true, hotels: result?.hotels ?? [], cached: result?.cached ?? false });
    } catch (err: any) {
      console.error('[Hotels API] Error:', err);
      res.status(500).json({ error: 'Could not load hotels', details: err?.message });
    }
  });

  // Ground schedules for one leg: real transit directions (Google Routes, needs a key) and the 12Go
  // regional timetable. Both are cached for 7 days; each part is empty when its source has nothing.
  app.get('/api/ground/schedules', async (req, res) => {
    try {
      const num = (v: unknown) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : NaN);
      const fromLat = num(req.query.fromLat);
      const fromLng = num(req.query.fromLng);
      const toLat = num(req.query.toLat);
      const toLng = num(req.query.toLng);
      const validPoint = (lat: number, lng: number) => Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
      if (![fromLat, fromLng, toLat, toLng].every(Number.isFinite) || !validPoint(fromLat, fromLng) || !validPoint(toLat, toLng)) {
        return res.status(400).json({ error: 'fromLat, fromLng, toLat and toLng are required coordinates.' });
      }
      const text = (v: unknown) => String(v ?? '').trim().slice(0, 80);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date ?? '')) ? String(req.query.date) : undefined;
      const people = Math.min(9, Math.max(1, Math.floor(num(req.query.people)) || 1));
      const fromCity = text(req.query.fromCity);
      const toCity = text(req.query.toCity);
      const fromCc = twelveGoCountry(text(req.query.fromCountry));
      const toCc = twelveGoCountry(text(req.query.toCountry));

      const [google, twelveGo] = await Promise.all([
        googleMapsKey()
          ? fetchGoogleTransitRoutes({ from: { lat: fromLat, lng: fromLng }, to: { lat: toLat, lng: toLng }, date })
          : Promise.resolve(null),
        fromCc && toCc && fromCity && toCity
          ? fetchTwelveGoTimetable({ country: fromCc, from: fromCity, to: toCity, date, people })
          : Promise.resolve(null),
      ]);
      const body: GroundSchedules = {
        google: { enabled: Boolean(googleMapsKey()), routes: google ?? [] },
        twelveGo: { supported: Boolean(fromCc && toCc), routes: twelveGo ?? [] },
      };
      res.json(body);
    } catch (err: any) {
      console.error('[Ground Schedules API] Error:', err);
      res.status(500).json({ error: 'Could not load schedules', details: err?.message });
    }
  });

  // Dedicated Transit Query Endpoint with Upstash Redis Caching & Live Fallback
  app.get('/api/transit/query', async (req, res) => {
    try {
      const origin = String(req.query.origin || '').trim();
      const destination = String(req.query.destination || '').trim();
      const date = String(req.query.date || '').trim() || '2026-11-21';
      const returnDate = String(req.query.returnDate || '').trim() || undefined;
      const mode = (String(req.query.mode || 'all').trim().toLowerCase()) as 'all' | TransitMode;
      const hourlyRate = sanitizeHourlyRate(req.query.hourlyRate ?? 15);
      if (!origin || !destination) {
        return res.status(400).json({
          error: 'Missing required parameters: "origin" and "destination" are required.',
        });
      }

      const result = await queryTransitWithCache({
        origin,
        destination,
        date,
        returnDate,
        mode,
        hourlyRateUsd: hourlyRate,
        travelerProfile: sanitizeProfile({
          priceWeight: req.query.priceWeight,
          timeWeight: req.query.timeWeight,
          allowRedEyes: req.query.allowRedEyes,
        }),
        passengers: Number(req.query.passengers) || 1,
      });

      res.setHeader('X-Cache-Key', result.cacheKey);
      res.setHeader('X-Cache-Status', result.cached ? 'HIT' : 'MISS');
      res.setHeader('X-Cache-Source', result.source);

      res.json(result);
    } catch (err: any) {
      console.error('[Transit Query API] Error handling GET query:', err);
      res.status(500).json({ error: 'Internal transit query error', details: err?.message });
    }
  });

  app.post('/api/transit/query', async (req, res) => {
    try {
      const {
        origin = '',
        destination = '',
        date = '2026-11-21',
        returnDate,
        mode = 'all',
        hourlyRate = 15,
        travelerProfile,
        passengers = 1,
      } = req.body as {
        origin: string;
        destination: string;
        date?: string;
        returnDate?: string;
        mode?: 'all' | TransitMode;
        hourlyRate?: number;
        travelerProfile?: Partial<TravelerProfile>;
        passengers?: number;
      };

      if (!origin || !destination) {
        return res.status(400).json({
          error: 'Missing required parameters: "origin" and "destination" are required.',
        });
      }

      if (typeof origin !== 'string' || typeof destination !== 'string') {
        return res.status(400).json({ error: '"origin" and "destination" must be strings.' });
      }

      const result = await queryTransitWithCache({
        origin,
        destination,
        date,
        returnDate,
        mode,
        hourlyRateUsd: sanitizeHourlyRate(hourlyRate),
        travelerProfile: sanitizeProfile(travelerProfile),
        passengers: Number(passengers) || 1,
      });

      res.setHeader('X-Cache-Key', result.cacheKey);
      res.setHeader('X-Cache-Status', result.cached ? 'HIT' : 'MISS');
      res.setHeader('X-Cache-Source', result.source);

      res.json(result);
    } catch (err: any) {
      console.error('[Transit Query API] Error handling POST query:', err);
      res.status(500).json({ error: 'Internal transit query error', details: err?.message });
    }
  });

  // Recompute legs when stops change or VTTS changes (with Redis caching wrapper)
  app.post('/api/legs/recompute', async (req, res) => {
   try {
    const {
      stops = [],
      hourlyTimeValue = 15,
      previousSelectedMap = {},
      travelerProfile: rawProfile,
      travelers = 1,
      legPrefs: rawLegPrefs,
    } = req.body as {
      stops: TripStop[];
      hourlyTimeValue: number;
      travelerProfile?: Partial<TravelerProfile>;
      travelers?: number;
      previousSelectedMap?: Record<string, string>;
      legPrefs?: unknown;
    };

    if (!Array.isArray(stops)) {
      return res.status(400).json({ error: '"stops" must be an array of TripStop objects.' });
    }
    const rate = sanitizeHourlyRate(hourlyTimeValue);
    const normalizedStops = stops.map((s, idx) => ({ ...s, order: idx + 1 }));
    const profile = sanitizeProfile(rawProfile);
    const passengers = Number(travelers) || 1;

    const legs = await buildLegsViaTransitService(normalizedStops, {
      hourlyRate: rate,
      profile,
      passengers,
      previousSelectedMap,
      legPrefs: sanitizeLegPrefs(rawLegPrefs),
    });
    logLegs('recompute', legs);
    res.json({ stops: normalizedStops, legs });
   } catch (err: any) {
    // Express 4 does not catch rejected async handlers; without this the request hangs forever
    console.error('[Legs Recompute API] Error:', err);
    res.status(500).json({ error: 'Failed to recompute legs', details: err?.message });
   }
  });

  // Two-Stage Global Route Optimizer
  app.post('/api/optimize-route', (req, res) => {
    const {
      stops = [],
      hourlyTimeValue: rawHourlyTimeValue = 15,
      lockOrigin = true,
      travelerProfile: rawProfile,
      travelers = 1,
    } = req.body as {
      stops: TripStop[];
      hourlyTimeValue: number;
      travelerProfile?: Partial<TravelerProfile>;
      travelers?: number;
      lockOrigin?: boolean;
    };

    if (!Array.isArray(stops) || stops.length < 2) {
      return res.status(400).json({ error: 'At least 2 stops are required to optimize.' });
    }

    const hourlyTimeValue = sanitizeHourlyRate(rawHourlyTimeValue);
    const scoring = { profile: sanitizeProfile(rawProfile), passengers: Number(travelers) || 1 };

    const originalLegs = buildLegsFromStops(
      stops,
      CURATED_CORRIDOR_OPTIONS,
      hourlyTimeValue,
      undefined,
      scoring
    );
    const originalSummary = summarizeLegs(originalLegs);

    // Stage 1: Evaluate all geographical permutations (capped safely at <= 7 permutable stops)
    const origin = lockOrigin ? stops[0] : null;
    const pool = lockOrigin ? stops.slice(1) : stops;
    // Only the first 6 permutable stops are reordered (6! = 720 candidates). Stops beyond the cap
    // are kept in their original order after the permuted block; previously they were silently
    // dropped from optimizedStops, deleting destinations from the trip on "Apply".
    const cappedPool = pool.slice(0, 6);
    const fixedTail = pool.slice(6);
    const perms = getPermutations(cappedPool);

    const stage1Ranked = perms
      .map((perm) => {
        const candidateStops = [...(origin ? [origin] : []), ...perm, ...fixedTail].map((s, idx) => ({
          ...s,
          order: idx + 1,
        }));
        return {
          stops: candidateStops,
          distanceKm: computeTotalDistance(candidateStops),
        };
      })
      // Recurring stops make different permutations spell the same route: keep one of each
      .filter(
        (entry, idx, all) =>
          all.findIndex(
            (other) =>
              other.stops.map((s) => s.iataCode).join('>') ===
              entry.stops.map((s) => s.iataCode).join('>')
          ) === idx
      )
      .sort((a, b) => a.distanceKm - b.distanceKm);

    // Stage 2: Query/compute transit options and weighted Smart Score for top 5 geographical candidates
    const topStage1 = stage1Ranked.slice(0, 5);
    const stage2Evaluated: Array<{
      stops: TripStop[];
      legs: TripLeg[];
      candidate: OptimizationCandidate;
    }> = topStage1.map((entry, idx) => {
      const legs = buildLegsFromStops(
        entry.stops,
        CURATED_CORRIDOR_OPTIONS,
        hourlyTimeValue,
        undefined,
        scoring
      );
      const stats = summarizeLegs(legs);
      return {
        stops: entry.stops,
        legs,
        candidate: {
          stopIds: entry.stops.map((s) => s.id),
          routeLabels: entry.stops.map((s) => `${s.city} (${s.iataCode})`),
          totalDistanceKm: stats.totalDistanceKm,
          estimatedTotalCostUsd: stats.totalCostUsd,
          estimatedTotalHours: stats.totalHours,
          totalSmartScore: stats.totalSmartScore,
          stage1Rank: idx + 1,
        },
      };
    });

    stage2Evaluated.sort(
      (a, b) => a.candidate.totalSmartScore - b.candidate.totalSmartScore
    );

    const winner = stage2Evaluated[0];
    const sameOrder =
      winner.stops.map((s) => s.id).join('>') === stops.map((s) => s.id).join('>');

    const distanceSavedKm = Math.max(
      0,
      originalSummary.totalDistanceKm - winner.candidate.totalDistanceKm
    );

    const result: RouteOptimizationResult = {
      originalDistanceKm: originalSummary.totalDistanceKm,
      optimizedDistanceKm: winner.candidate.totalDistanceKm,
      distanceSavedKm,
      originalCostUsd: originalSummary.totalCostUsd,
      optimizedCostUsd: winner.candidate.estimatedTotalCostUsd,
      originalSmartScore: originalSummary.totalSmartScore,
      optimizedSmartScore: winner.candidate.totalSmartScore,
      optimizedStops: winner.stops,
      optimizedLegs: winner.legs,
      candidatesEvaluated: stage1Ranked.length,
      topCandidates: stage2Evaluated.map((e) => e.candidate),
      alreadyOptimal: sameOrder,
      summaryMessage: sameOrder
        ? 'Your current stop sequence already achieves the lowest Smart Score across evaluated corridors.'
        : `Reordering stops saves ${distanceSavedKm.toLocaleString()} km and lowers your weighted Smart Score by ${round2(
            originalSummary.totalSmartScore - winner.candidate.totalSmartScore
          )} points.`,
    };

    res.json(result);
  });

  return app;
}

async function startServer() {
  const app = createApp();

  // Vite middleware in development; static serving in production
  if (process.env.NODE_ENV !== 'production') {
    // Imported lazily so the serverless bundle (api/index.ts) never pulls Vite in
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Astris Travel server listening on http://0.0.0.0:${PORT}`);
  });
}

// On Vercel the platform calls the handler in api/index.ts; there is no port to listen on
if (!process.env.VERCEL) {
  startServer().catch((err) => {
    console.error('[Astris] Server failed to start:', err);
    process.exit(1);
  });
}
