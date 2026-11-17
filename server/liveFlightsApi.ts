import type { Express, Response } from 'express';
import { useRealData } from './env.ts';
import { getRates } from './ratesService.ts';
import { getRedisClient, liveOffersToOptions } from './transitService.ts';
import { createSerpApiProvider, ProviderError, type FlightProvider } from './flightProvider.ts';
import { createTtlCache, getOrFetch } from './ttlCache.ts';
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

const IATA_RE = /^[A-Za-z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Za-z]{3}$/;

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** Validates and normalises a search body. */
export function parseLiveSearch(body: unknown): Parsed<LiveSearchRequest> {
  const b = (body ?? {}) as Record<string, unknown>;
  const origin = String(b.originIata ?? '').trim().toUpperCase();
  const destination = String(b.destinationIata ?? '').trim().toUpperCase();
  if (!IATA_RE.test(origin) || !IATA_RE.test(destination)) {
    return { ok: false, message: 'originIata and destinationIata must be 3-letter IATA codes.' };
  }
  if (origin === destination) return { ok: false, message: 'Origin and destination must differ.' };
  const departureDate = String(b.departureDate ?? '');
  if (!DATE_RE.test(departureDate)) return { ok: false, message: 'departureDate must be YYYY-MM-DD.' };
  let returnDate: string | undefined;
  if (b.returnDate !== undefined && b.returnDate !== null && b.returnDate !== '') {
    returnDate = String(b.returnDate);
    if (!DATE_RE.test(returnDate) || returnDate < departureDate) {
      return { ok: false, message: 'returnDate must be YYYY-MM-DD and not before departureDate.' };
    }
  }
  const adults = b.adults === undefined ? 1 : Number(b.adults);
  if (!Number.isInteger(adults) || adults < 1 || adults > 9) {
    return { ok: false, message: 'adults must be a whole number from 1 to 9.' };
  }
  const currency = b.currency === undefined ? 'USD' : String(b.currency).trim().toUpperCase();
  if (!CURRENCY_RE.test(currency)) return { ok: false, message: 'currency must be a 3-letter ISO code.' };
  return { ok: true, value: { originIata: origin, destinationIata: destination, departureDate, returnDate, adults, currency } };
}

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

export function registerLiveFlightRoutes(app: Express, provider: FlightProvider = createSerpApiProvider()): void {
  const offline = (req: LiveSearchRequest, reason: OfflineReason): LiveSearchResponse => ({
    mode: 'offline',
    offers: [],
    options: [],
    cached: false,
    fetchedAt: new Date().toISOString(),
    reason,
    fallbackLinks: offlineFallbackLinks(req),
  });

  app.post('/api/flights/live-search', async (req, res) => {
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

  app.post('/api/flights/return-flights', async (req, res) => {
    const parsed = parseLiveSearch(req.body);
    const departureToken = String((req.body as Record<string, unknown>)?.departureToken ?? '');
    if (!parsed.ok || !parsed.value.returnDate) {
      return sendError(res, 400, { error: 'BAD_REQUEST', message: parsed.ok ? 'returnDate is required.' : parsed.message });
    }
    if (departureToken.length < 8 || departureToken.length > 8192) {
      return sendError(res, 400, { error: 'BAD_REQUEST', message: 'departureToken is required.' });
    }
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

  app.post('/api/flights/booking-options', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const bookingToken = String(b.bookingToken ?? '');
    const currency = b.currency === undefined ? 'USD' : String(b.currency).trim().toUpperCase();
    if (bookingToken.length < 8 || bookingToken.length > 8192 || !CURRENCY_RE.test(currency)) {
      return sendError(res, 400, { error: 'BAD_REQUEST', message: 'bookingToken is required.' });
    }
    // The search the token came from (see BookingOptionsRequest)
    const search = parseLiveSearch(b.search);
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
