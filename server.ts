// MUST stay the first import: loads .env.local / .env before any service reads process.env
import { logEnvStatus } from './server/env.ts';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
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
  VOUCHERS_CATALOG,
  createDefaultTrip,
} from './shared/mockDataset.ts';
import {
  buildLegIds,
  buildLegsFromStops,
  calculateVoucherDiscount,
  haversineDistanceKm,
  isVoucherCurrentlyValid,
  round2,
  sanitizeHourlyRate,
} from './shared/smartScore.ts';
import type {
  OptimizationCandidate,
  RouteOptimizationResult,
  TransitMode,
  TravelerProfile,
  TripLeg,
  TripStop,
  Voucher,
  VoucherValidationResult,
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

/** Case-insensitive code match against the catalog, excluding expired / inactive vouchers. */
function resolveActiveVouchers(codes: unknown): Voucher[] {
  if (!Array.isArray(codes)) return [];
  const wanted = new Set(
    codes.filter((c): c is string => typeof c === 'string').map((c) => c.trim().toUpperCase())
  );
  return VOUCHERS_CATALOG.filter(
    (v) => wanted.has(v.code.toUpperCase()) && isVoucherCurrentlyValid(v)
  );
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
    const selected =
      leg.transitOptions.find((o) => o.id === leg.selectedOptionId) ??
      leg.transitOptions[0];
    if (selected) {
      totalCostUsd += selected.discountedPriceUsd;
      totalHours += selected.inVehicleHours + selected.layoverHours;
      totalSmartScore += selected.smartScore;
    }
  }

  return {
    totalDistanceKm,
    totalCostUsd: round2(totalCostUsd),
    totalHours: round2(totalHours),
    totalSmartScore: round2(totalSmartScore),
  };
}

async function startServer() {
  logEnvStatus();
  const app = express();
  app.use(express.json());

  // Health & initial dataset
  app.get('/api/trips/default', (_req, res) => {
    res.json(createDefaultTrip());
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

  app.get('/api/vouchers', (_req, res) => {
    res.json({ vouchers: VOUCHERS_CATALOG });
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

  // Dedicated Transit Query Endpoint with Upstash Redis Caching & Live Fallback
  app.get('/api/transit/query', async (req, res) => {
    try {
      const origin = String(req.query.origin || '').trim();
      const destination = String(req.query.destination || '').trim();
      const date = String(req.query.date || '').trim() || '2026-11-21';
      const mode = (String(req.query.mode || 'all').trim().toLowerCase()) as 'all' | TransitMode;
      const hourlyRate = sanitizeHourlyRate(req.query.hourlyRate ?? 15);
      const voucherCodesParam = String(req.query.voucherCodes || '').trim();
      const appliedCodes = voucherCodesParam
        ? voucherCodesParam.split(',').map((c) => c.trim()).filter(Boolean)
        : [];
      const activeVouchers = resolveActiveVouchers(appliedCodes);

      if (!origin || !destination) {
        return res.status(400).json({
          error: 'Missing required parameters: "origin" and "destination" are required.',
        });
      }

      const result = await queryTransitWithCache({
        origin,
        destination,
        date,
        mode,
        hourlyRateUsd: hourlyRate,
        activeVouchers,
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
        mode = 'all',
        hourlyRate = 15,
        appliedVoucherCodes = [],
        travelerProfile,
        passengers = 1,
      } = req.body as {
        origin: string;
        destination: string;
        date?: string;
        mode?: 'all' | TransitMode;
        hourlyRate?: number;
        appliedVoucherCodes?: string[];
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

      const activeVouchers = resolveActiveVouchers(appliedVoucherCodes);

      const result = await queryTransitWithCache({
        origin,
        destination,
        date,
        mode,
        hourlyRateUsd: sanitizeHourlyRate(hourlyRate),
        activeVouchers,
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

  // Recompute legs when stops change, VTTS changes, or vouchers toggle (with Redis caching wrapper)
  app.post('/api/legs/recompute', async (req, res) => {
   try {
    const {
      stops = [],
      hourlyTimeValue = 15,
      appliedVoucherCodes = [],
      previousSelectedMap = {},
      travelerProfile: rawProfile,
      travelers = 1,
    } = req.body as {
      stops: TripStop[];
      hourlyTimeValue: number;
      travelerProfile?: Partial<TravelerProfile>;
      travelers?: number;
      appliedVoucherCodes: string[];
      previousSelectedMap?: Record<string, string>;
    };

    if (!Array.isArray(stops)) {
      return res.status(400).json({ error: '"stops" must be an array of TripStop objects.' });
    }
    const rate = sanitizeHourlyRate(hourlyTimeValue);
    const normalizedStops = stops.map((s, idx) => ({ ...s, order: idx + 1 }));
    const activeVouchers = resolveActiveVouchers(appliedVoucherCodes);
    const legIds = buildLegIds(normalizedStops);
    const profile = sanitizeProfile(rawProfile);
    const passengers = Number(travelers) || 1;

    // Query each corridor transit options concurrently via Upstash Redis caching wrapper
    const legPromises: Promise<TripLeg | undefined>[] = [];
    for (let i = 0; i < normalizedStops.length - 1; i++) {
      const fromStop = normalizedStops[i];
      const toStop = normalizedStops[i + 1];
      const legId = legIds[i];
      const distanceKm = haversineDistanceKm(fromStop.lat, fromStop.lng, toStop.lat, toStop.lng);

      legPromises.push(
        queryTransitWithCache({
          origin: fromStop.iataCode,
          destination: toStop.iataCode,
          date: fromStop.departureDate,
          mode: 'all',
          hourlyRateUsd: rate,
          activeVouchers,
          travelerProfile: profile,
          passengers,
          fromStop,
          toStop,
        }).then((result) => {
          const rankedOptions = result.options.map((o) => ({ ...o, legId }));
          const prevSelected = previousSelectedMap?.[legId];
          const validPrev = rankedOptions.some((o) => o.id === prevSelected);

          const leg: TripLeg = {
            id: legId,
            fromStopId: fromStop.id,
            toStopId: toStop.id,
            fromCity: fromStop.city,
            fromCode: fromStop.iataCode,
            toCity: toStop.city,
            toCode: toStop.iataCode,
            distanceKm,
            selectedOptionId: validPrev ? prevSelected! : rankedOptions[0]?.id ?? '',
            transitOptions: rankedOptions,
          };
          return leg;
        }).catch((err) => {
          console.warn(`[Transit Cache] Failed leg query for ${fromStop.iataCode}->${toStop.iataCode}, using synchronous fallback:`, err);
          // Graceful fallback to synchronous builder if query fails
          const fallback = buildLegsFromStops(
            [fromStop, toStop],
            CURATED_CORRIDOR_OPTIONS,
            VOUCHERS_CATALOG,
            rate,
            activeVouchers,
            undefined,
            { profile, passengers }
          )[0];
          if (!fallback) return undefined;
          // A 2-stop rebuild always yields the base id; restore this leg's (possibly suffixed) id
          const prevSelected = previousSelectedMap?.[legId];
          const leg: TripLeg = {
            ...fallback,
            id: legId,
            selectedOptionId: fallback.transitOptions.some((o) => o.id === prevSelected)
              ? prevSelected!
              : fallback.selectedOptionId,
          };
          return leg;
        })
      );
    }

    const legs = await Promise.all(legPromises);
    res.json({ stops: normalizedStops, legs: legs.filter(Boolean) });
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
      appliedVoucherCodes = [],
      lockOrigin = true,
      travelerProfile: rawProfile,
      travelers = 1,
    } = req.body as {
      stops: TripStop[];
      hourlyTimeValue: number;
      travelerProfile?: Partial<TravelerProfile>;
      travelers?: number;
      appliedVoucherCodes: string[];
      lockOrigin?: boolean;
    };

    if (!Array.isArray(stops) || stops.length < 2) {
      return res.status(400).json({ error: 'At least 2 stops are required to optimize.' });
    }

    const hourlyTimeValue = sanitizeHourlyRate(rawHourlyTimeValue);
    const activeVouchers = resolveActiveVouchers(appliedVoucherCodes);
    const scoring = { profile: sanitizeProfile(rawProfile), passengers: Number(travelers) || 1 };

    const originalLegs = buildLegsFromStops(
      stops,
      CURATED_CORRIDOR_OPTIONS,
      VOUCHERS_CATALOG,
      hourlyTimeValue,
      activeVouchers,
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
        VOUCHERS_CATALOG,
        hourlyTimeValue,
        activeVouchers,
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

  // Voucher validation endpoint
  app.post('/api/vouchers/validate', (req, res) => {
    const { code = '', legs = [] } = req.body as {
      code: string;
      legs: TripLeg[];
    };

    const normalizedCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
    const voucher = VOUCHERS_CATALOG.find(
      (v) => v.code.toUpperCase() === normalizedCode
    );

    if (!voucher) {
      const invalid: VoucherValidationResult = {
        valid: false,
        reason: `Code "${normalizedCode || 'EMPTY'}" was not recognized. Try ASTRIS15, RAIL20, ISTHUB40, or COACH10.`,
        eligibleLegIds: [],
        estimatedSavingsUsd: 0,
      };
      return res.json(invalid);
    }

    if (!isVoucherCurrentlyValid(voucher)) {
      const expired: VoucherValidationResult = {
        valid: false,
        reason: `Code "${voucher.code}" is not currently active (valid until ${voucher.expiresAt}).`,
        eligibleLegIds: [],
        estimatedSavingsUsd: 0,
      };
      return res.json(expired);
    }

    const eligibleLegIds: string[] = [];
    let estimatedSavingsUsd = 0;

    for (const leg of Array.isArray(legs) ? legs : []) {
      if (!Array.isArray(leg?.transitOptions)) continue;
      const bestOnLeg = leg.transitOptions.reduce((maxSav, opt) => {
        const sav = calculateVoucherDiscount(opt, voucher);
        return sav > maxSav ? sav : maxSav;
      }, 0);

      if (bestOnLeg > 0) {
        eligibleLegIds.push(leg.id);
        estimatedSavingsUsd += bestOnLeg;
      }
    }

    const response: VoucherValidationResult = {
      valid: true,
      voucher,
      eligibleLegIds,
      estimatedSavingsUsd: round2(estimatedSavingsUsd),
      reason:
        eligibleLegIds.length > 0
          ? `Matches ${eligibleLegIds.length} leg${eligibleLegIds.length > 1 ? 's' : ''} in your itinerary.`
          : 'Valid promo code, though none of your current legs meet its mode/minimum spend rules.',
    };

    res.json(response);
  });

  // Vite middleware in development; static serving in production
  if (process.env.NODE_ENV !== 'production') {
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

startServer().catch((err) => {
  console.error('[Astris] Server failed to start:', err);
  process.exit(1);
});
