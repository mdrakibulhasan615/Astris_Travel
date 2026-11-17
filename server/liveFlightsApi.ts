import type { Express, Response } from 'express';
import { useRealData } from './env.ts';
import { getRates } from './ratesService.ts';
import { getRedisClient, liveOffersToOptions } from './transitService.ts';
import { createSerpApiProvider, ProviderError, type FlightProvider } from './flightProvider.ts';
import { createTtlCache, getOrFetch } from './ttlCache.ts';
import { bookingOptionsSchema, parseLiveSearch, parseWith, returnFlightsSchema } from './security/validation.ts';
import { createLimiter, rateLimit, RATE_LIMITS, type Limiter } from './security/rateLimit.ts';
import {
  bookingOptionsCacheKey,
  hashKey,
  liveSearchCacheKey,
  offlineFallbackLinks,
  type BookingOptionsResponse,
  type LiveFlightErrorBody,
  type LiveFlightOffer,
  type LiveSearchRequest,
  type LiveSearchResponse,
  type OfflineReason,
  type ReturnFlightsResponse,
  type ReturnFlightsRequest,
  type SellerBookingOption,
} from '../shared/liveFlights.ts';

/**
 * Live fares in two steps, both on request only (never on page load or a filter change):
 *
 *   POST /api/flights/live-search      flights for a corridor (cached 30 min)
 *   POST /api/flights/return-flights   return flights for a chosen outbound `departureToken` (cached 30 min)
 *   POST /api/flights/booking-options  the sellers of ONE exact ticket (cached 15 min)
 *
 * Each uncached call spends one SerpApi search (the free plan has 100 a month), so the caches are
 * keyed to hit whenever the same corridor, or the same ticket's seller list, is opened again.
 */

export const OFFERS_TTL_SECONDS = 30 * 60;
export const BOOKING_TTL_SECONDS = 15 * 60;

const offersCache = createTtlCache<LiveFlightOffer[]>({ ttlSeconds: OFFERS_TTL_SECONDS, redis: getRedisClient });
const bookingCache = createTtlCache<SellerBookingOption[]>({ ttlSeconds: BOOKING_TTL_SECONDS, redis: getRedisClient });

export { parseLiveSearch };

function sendError(res: Response, status: number, body: LiveFlightErrorBody) {
  return res.status(status).json(body);
}

/** HTTP status for a provider failure. */
function statusFor(err: ProviderError): number {
  switch (err.code) {
    case 'BAD_REQUEST':
      return 400;
    case 'TOKEN_EXPIRED':
      return 410;
    case 'QUOTA_EXCEEDED':
      return 429;
    case 'NO_KEY':
      return 503;
    default:
      return 502;
  }
}

/** Scoring inputs the browser may send so the cards rank like the rest of the itinerary. */
function scoringOf(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const hourly = Number(b.hourlyRateUsd);
  return {
    hourlyRateUsd: Number.isFinite(hourly) && hourly >= 0 && hourly <= 1000 ? hourly : 15,
    passengers: Math.min(9, Math.max(1, Math.floor(Number(b.passengers)) || 1)),
  };
}

async function usdPerUnit(currency: string): Promise<number> {
  if (currency === 'USD') return 1;
  const rate = (await getRates()).rates[currency];
  return Number.isFinite(rate) && rate > 0 ? 1 / rate : 1;
}

export interface LiveFlightLimiters {
  liveSearch: Limiter;
  returnFlights: Limiter;
  bookingOptions: Limiter;
}

/** Per-IP / per-session sliding windows (Upstash when configured, memory otherwise). */
export function defaultLiveFlightLimiters(): LiveFlightLimiters {
  return {
    liveSearch: createLimiter(RATE_LIMITS.liveSearch, getRedisClient),
    returnFlights: createLimiter(RATE_LIMITS.returnFlights, getRedisClient),
    bookingOptions: createLimiter(RATE_LIMITS.bookingOptions, getRedisClient),
  };
}

export function registerLiveFlightRoutes(
  app: Express,
  provider: FlightProvider = createSerpApiProvider(),
  limiters: LiveFlightLimiters = defaultLiveFlightLimiters()
): void {
  const offline = (req: LiveSearchRequest, reason: OfflineReason): LiveSearchResponse => ({
    mode: 'offline',
    offers: [],
    options: [],
    cached: false,
    fetchedAt: new Date().toISOString(),
    reason,
    fallbackLinks: offlineFallbackLinks(req),
  });

  app.post('/api/flights/live-search', rateLimit(RATE_LIMITS.liveSearch, limiters.liveSearch), async (req, res) => {
    const parsed = parseLiveSearch(req.body);
    if (!parsed.ok) return sendError(res, 400, { error: 'BAD_REQUEST', message: parsed.message });
    const search = parsed.value;
    // The flag that keeps development on sample data also keeps this button from spending searches
    if (!useRealData()) return res.json(offline(search, 'DISABLED'));

    try {
      const { value: offers, cached } = await getOrFetch(offersCache, liveSearchCacheKey(search), () =>
        provider.searchCorridor(search)
      );
      const { hourlyRateUsd, passengers } = scoringOf(req.body);
      const out: LiveSearchResponse = {
        mode: 'live',
        offers,
        options: liveOffersToOptions(offers, {
          origin: search.originIata,
          destination: search.destinationIata,
          date: search.departureDate,
          returnDate: search.returnDate,
          hourlyRateUsd,
          passengers,
          usdPerUnit: await usdPerUnit(search.currency ?? 'USD'),
        }),
        cached,
        fetchedAt: offers[0]?.fetchedAt ?? new Date().toISOString(),
        fallbackLinks: [],
      };
      res.json(out);
    } catch (err) {
      if (err instanceof ProviderError) {
        console.warn(`[Live Flights] search failed (${err.code}): ${err.message}`);
        if (err.code === 'NO_KEY') return res.json(offline(search, 'NO_KEY'));
        if (err.code === 'QUOTA_EXCEEDED') return res.json(offline(search, 'QUOTA_EXCEEDED'));
        return sendError(res, statusFor(err), { error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/api/flights/return-flights', rateLimit(RATE_LIMITS.returnFlights, limiters.returnFlights), async (req, res) => {
    const body = parseWith(returnFlightsSchema, req.body);
    if (!body.ok) return sendError(res, 400, { error: 'BAD_REQUEST', message: body.message });
    const parsed = parseLiveSearch(req.body);
    if (!parsed.ok || !parsed.value.returnDate) {
      return sendError(res, 400, { error: 'BAD_REQUEST', message: parsed.ok ? 'returnDate is required.' : parsed.message });
    }
    const departureToken = body.value.departureToken;
    if (!useRealData()) return sendError(res, 503, { error: 'NO_KEY', message: 'Live fares are switched off.' });
    const search = parsed.value as ReturnFlightsRequest;

    try {
      const key = `live-flights:return:v1:${(search.currency ?? 'USD').toUpperCase()}:${hashKey(departureToken)}${departureToken.length.toString(36)}`;
      const { value: offers, cached } = await getOrFetch(offersCache, key, () =>
        provider.getReturnFlights({ ...search, departureToken })
      );
      const { hourlyRateUsd, passengers } = scoringOf(req.body);
      const out: ReturnFlightsResponse = {
        offers,
        options: liveOffersToOptions(offers, {
          // Return flights run the other way
          origin: search.destinationIata,
          destination: search.originIata,
          date: search.returnDate!,
          hourlyRateUsd,
          passengers,
          usdPerUnit: await usdPerUnit(search.currency ?? 'USD'),
        }),
        cached,
        fetchedAt: offers[0]?.fetchedAt ?? new Date().toISOString(),
      };
      res.json(out);
    } catch (err) {
      if (err instanceof ProviderError) {
        console.warn(`[Live Flights] return flights failed (${err.code}): ${err.message}`);
        return sendError(res, statusFor(err), { error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/api/flights/booking-options', rateLimit(RATE_LIMITS.bookingOptions, limiters.bookingOptions), async (req, res) => {
    const body = parseWith(bookingOptionsSchema, req.body);
    if (!body.ok) return sendError(res, 400, { error: 'BAD_REQUEST', message: body.message });
    const { bookingToken, currency } = body.value;
    // The search the token came from (see BookingOptionsRequest)
    const search = parseLiveSearch((req.body as Record<string, unknown>).search);
    if (!search.ok) return sendError(res, 400, { error: 'BAD_REQUEST', message: `search: ${search.message}` });
    if (!useRealData()) return sendError(res, 503, { error: 'NO_KEY', message: 'Live fares are switched off.' });

    try {
      const { value: options, cached } = await getOrFetch(bookingCache, bookingOptionsCacheKey(bookingToken, currency), () =>
        provider.getBookingOptions({ bookingToken, currency, search: search.value })
      );
      const out: BookingOptionsResponse = { options, cached, fetchedAt: new Date().toISOString() };
      res.json(out);
    } catch (err) {
      if (err instanceof ProviderError) {
        console.warn(`[Live Flights] booking options failed (${err.code}): ${err.message}`);
        return sendError(res, statusFor(err), {
          error: err.code,
          message:
            err.code === 'TOKEN_EXPIRED'
              ? 'This fare has expired. Fetch live fares again for current prices.'
              : err.message,
        });
      }
      throw err;
    }
  });
}
