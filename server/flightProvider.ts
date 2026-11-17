// MUST stay the first import so env is loaded before the SerpApi key is read
import { getEnv } from './env.ts';
import { airportsForCity } from '../shared/airports.ts';
import {
  normalizeSerpFlights,
  parseBookingOptions,
  type BookingOptionsRequest,
  type LiveFlightErrorCode,
  type LiveFlightOffer,
  type LiveSearchRequest,
  type ReturnFlightsRequest,
  type SellerBookingOption,
} from '../shared/liveFlights.ts';

/**
 * Where live fares come from, behind one interface. Today that is SerpApi's Google Flights engine
 * (free tier: 100 searches a month). When traffic or a company entity opens up a better source
 * (Travelpayouts' real-time search, Duffel…), add another `FlightProvider` and swap it in
 * `server/liveFlightsApi.ts`; nothing in the browser changes.
 */
export interface FlightProvider {
  readonly name: string;
  /** Flights for a corridor. Round trips return the OUTBOUND flights, each with a `departureToken`. */
  searchCorridor(req: LiveSearchRequest): Promise<LiveFlightOffer[]>;
  /** Return flights for a chosen outbound (`departureToken`), each with a `bookingToken`. */
  getReturnFlights(req: ReturnFlightsRequest): Promise<LiveFlightOffer[]>;
  /** Every seller of one exact ticket, with the request that opens its checkout. */
  getBookingOptions(req: BookingOptionsRequest): Promise<SellerBookingOption[]>;
}

export class ProviderError extends Error {
  constructor(
    public readonly code: LiveFlightErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

interface SerpApiOptions {
  apiKey?: () => string | undefined;
  fetchImpl?: typeof fetch;
  baseUrl?: () => string;
  now?: () => Date;
}

/** SerpApi's wording for "you have no searches left" (HTTP 429, or a 200/4xx with an `error`). */
const QUOTA_RE = /run out of searches|out of searches|plan'?s? (?:search )?limit|exceeded|quota|too many requests|rate limit/i;
const KEY_RE = /invalid api key|api key (?:is )?(?:missing|not valid)|unauthori[sz]ed/i;
const EXPIRED_RE = /token|expired|no longer|invalid.*(?:booking|flight)/i;
const MISSING_PARAM_RE = /missing|required parameter|unsupported parameter/i;
const NO_RESULTS_RE = /hasn'?t returned any results|no results|did not return any results/i;

export function createSerpApiProvider(opts: SerpApiOptions = {}): FlightProvider {
  const apiKey = opts.apiKey ?? (() => getEnv('SERPAPI_API_KEY'));
  const doFetch = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? (() => getEnv('SERPAPI_BASE_URL') ?? 'https://serpapi.com/search.json');
  const now = opts.now ?? (() => new Date());

  /** One SerpApi call. Maps every failure to a typed `ProviderError`. */
  async function call(params: Record<string, string>, kind: 'search' | 'booking'): Promise<Record<string, any>> {
    const key = apiKey();
    if (!key) throw new ProviderError('NO_KEY', 'SERPAPI_API_KEY is not set.');
    const url = new URL(baseUrl());
    for (const [k, v] of Object.entries({ engine: 'google_flights', ...params, api_key: key })) url.searchParams.set(k, v);

    let res: Response;
    try {
      res = await doFetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      throw new ProviderError('UPSTREAM_ERROR', `SerpApi could not be reached: ${(err as Error)?.message ?? err}`);
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const message = typeof body?.error === 'string' ? body.error : '';

    if (res.status === 429 || QUOTA_RE.test(message)) {
      throw new ProviderError('QUOTA_EXCEEDED', message || 'The SerpApi search allowance is used up.', res.status);
    }
    if (res.status === 401 || res.status === 403 || KEY_RE.test(message)) {
      throw new ProviderError('NO_KEY', message || 'SerpApi rejected the API key.', res.status);
    }
    if (message && NO_RESULTS_RE.test(message)) return { best_flights: [], other_flights: [], booking_options: [] };
    if (message || !res.ok) {
      // Our own mistake (a missing parameter) is not an expired fare
      if (MISSING_PARAM_RE.test(message)) throw new ProviderError('BAD_REQUEST', message, res.status);
      if (kind === 'booking' && (EXPIRED_RE.test(message) || res.status === 404)) {
        throw new ProviderError('TOKEN_EXPIRED', message || 'This fare has expired.', res.status);
      }
      throw new ProviderError('UPSTREAM_ERROR', message || `SerpApi answered HTTP ${res.status}.`, res.status);
    }
    return body as Record<string, any>;
  }

  /** Google Flights answers metro codes (LON, PAR) with nothing, so ask for the city's airports. */
  const airports = (code: string, roundTrip: boolean) => {
    const ids = airportsForCity(code);
    // A round trip that lists several airports on either side comes back empty from Google Flights
    return (roundTrip ? ids.slice(0, 1) : ids).join(',');
  };

  function searchParams(req: LiveSearchRequest): Record<string, string> {
    const from = airports(req.originIata, Boolean(req.returnDate));
    const to = airports(req.destinationIata, Boolean(req.returnDate));
    if (!from || !to) throw new ProviderError('BAD_REQUEST', 'Origin and destination must be IATA codes.');
    return {
      departure_id: from,
      arrival_id: to,
      outbound_date: req.departureDate,
      // `type` defaults to round trip, which SerpApi refuses without a return date
      type: req.returnDate ? '1' : '2',
      ...(req.returnDate ? { return_date: req.returnDate } : {}),
      adults: String(req.adults ?? 1),
      currency: (req.currency ?? 'USD').toUpperCase(),
      hl: 'en',
    };
  }

  return {
    name: 'serpapi-google-flights',

    async searchCorridor(req) {
      const data = await call(searchParams(req), 'search');
      return normalizeSerpFlights(data, { currency: (req.currency ?? 'USD').toUpperCase(), fetchedAt: now().toISOString() });
    },

    async getReturnFlights(req) {
      const data = await call({ ...searchParams(req), departure_token: req.departureToken }, 'search');
      return normalizeSerpFlights(data, { currency: (req.currency ?? 'USD').toUpperCase(), fetchedAt: now().toISOString() });
    },

    async getBookingOptions(req) {
      // The token names the ticket, but SerpApi still needs the search it came from (verified against the
      // live API: a bare booking_token is rejected with "Missing `departure_id` parameter")
      const data = await call({ ...searchParams(req.search), booking_token: req.bookingToken }, 'booking');
      const options = parseBookingOptions(data);
      if (options.length === 0) throw new ProviderError('TOKEN_EXPIRED', 'No sellers are offering this fare any more.');
      return options;
    },
  };
}
