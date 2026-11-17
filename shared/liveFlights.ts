import { safeHttpsUrl } from './safeUrl.ts';
import { buildTripFlightUrl } from './affiliate.ts';
import { parseBaggage } from './ticketDetails.ts';
import type { BaggageInfo, TransitOption } from './types.ts';

/**
 * Live flight fares and the exact-ticket handoff, in two SerpApi Google Flights steps:
 *
 *   1. search            flights, prices, times, baggage hints and a `booking_token` (one-way) or
 *                        `departure_token` (round trip: pick the outbound, then fetch the return)
 *   2. booking options   one call per token: every seller of that exact ticket, its price, baggage
 *                        fees and the `booking_request` (url + post_data) that opens its checkout
 *
 * Everything in this file is pure (no I/O) so it can be unit-tested and shared with the browser.
 */

// ── Requests ─────────────────────────────────────────────────────────────────────────────────────

export interface LiveSearchRequest {
  /** City or airport IATA code (`LON` and `LHR` both work). */
  originIata: string;
  destinationIata: string;
  /** `YYYY-MM-DD` */
  departureDate: string;
  /** Present = round trip (priced for both directions). */
  returnDate?: string;
  adults?: number;
  /** ISO 4217, default `USD`. */
  currency?: string;
}

export interface BookingOptionsRequest {
  bookingToken: string;
  /**
   * The search the token came from. SerpApi answers a booking_token only together with that search's
   * own route and dates (without `departure_id` it answers HTTP 400, and with different airports it
   * finds nothing), so the lookup repeats them.
   */
  search: LiveSearchRequest;
  currency?: string;
}

export interface ReturnFlightsRequest extends LiveSearchRequest {
  returnDate: string;
  /** From the chosen outbound offer. */
  departureToken: string;
}

// ── Offers ───────────────────────────────────────────────────────────────────────────────────────

export interface LiveFlightSegment {
  /** e.g. `AK 880` */
  flightNumber: string;
  airline: string;
  airlineCode: string;
  airlineLogo?: string;
  fromIata: string;
  fromName: string;
  toIata: string;
  toName: string;
  /** Local time, `YYYY-MM-DD HH:MM`. */
  departureAt: string;
  arrivalAt: string;
  durationMinutes: number;
  airplane?: string;
  travelClass?: string;
  legroom?: string;
}

export interface LiveLayover {
  airportName: string;
  iata: string;
  durationMinutes: number;
  overnight: boolean;
}

export interface LiveFlightOffer {
  source: 'serpapi_live';
  /** Deterministic: the same itinerary and price give the same id. */
  id: string;
  airline: { name: string; iataCode: string; logo?: string };
  /** All flight numbers, in order: `AK 880 + MH 30`. */
  flightNumber: string;
  /** Local time of the first departure / last arrival, `YYYY-MM-DD HH:MM`. */
  departureTime: string;
  arrivalTime: string;
  totalDurationMinutes: number;
  stopsCount: number;
  layovers: LiveLayover[];
  segments: LiveFlightSegment[];
  price: number;
  currency: string;
  /** `1 carry-on · Checked bag included`, or `Baggage not stated` when the fare says nothing. */
  baggageSummary: string;
  baggage?: BaggageInfo;
  /** Legroom, Wi-Fi, power and the like, from the fare's extension strings. */
  amenities: string[];
  /** One-way offers (and chosen return legs): feeds the booking-options call. */
  bookingToken?: string;
  /** Round trips: the outbound is chosen first; this fetches its return flights. */
  departureToken?: string;
  co2Kg?: number;
  fetchedAt: string;
}

// ── Sellers ──────────────────────────────────────────────────────────────────────────────────────

export interface BookingRequest {
  url: string;
  /** Form-encoded body (`f.req=…`). Present = the checkout must be opened with a POST. */
  postData?: string;
}

export interface SellerBookingOption {
  /** Unique within the response. */
  id: string;
  /** Options that are bought together (one `together` entry, or a departing + returning pair). */
  groupId: string;
  part: 'together' | 'departing' | 'returning';
  /** The ticket is sold as two separate tickets (a `departing` + `returning` pair). */
  separateTickets: boolean;
  /** Airline or travel agency: `Malaysia Airlines`, `Trip.com`… */
  bookWith: string;
  isAirlineDirect: boolean;
  /** This part's price. */
  price: number;
  /** What the whole group costs (= `price` unless split). */
  groupPrice: number;
  baggagePrices: string[];
  optionTitle?: string;
  /** The seller's logo, as SerpApi sends it. */
  logo?: string;
  bookingRequest: BookingRequest;
}

// ── Errors ───────────────────────────────────────────────────────────────────────────────────────

export type LiveFlightErrorCode =
  | 'BAD_REQUEST'
  | 'NO_KEY'
  | 'QUOTA_EXCEEDED'
  | 'TOKEN_EXPIRED'
  | 'UPSTREAM_ERROR';

export interface LiveFlightErrorBody {
  error: LiveFlightErrorCode;
  message: string;
}

/** Why live fares are not being shown, so the UI can say so and offer the route links instead. */
export type OfflineReason = 'NO_KEY' | 'QUOTA_EXCEEDED' | 'DISABLED';

export interface FallbackLink {
  name: string;
  url: string;
}

export interface LiveSearchResponse {
  mode: 'live' | 'offline';
  offers: LiveFlightOffer[];
  /** The same offers as scored ticket cards (airport-anchored, ready to draw). */
  options: TransitOption[];
  /** `live`: this answer came from the 30-minute cache (no SerpApi search was spent). */
  cached: boolean;
  fetchedAt: string;
  reason?: OfflineReason;
  /** Offline: exact-route links so the traveller can still book. */
  fallbackLinks: FallbackLink[];
}

export interface ReturnFlightsResponse {
  offers: LiveFlightOffer[];
  options: TransitOption[];
  cached: boolean;
  fetchedAt: string;
}

export interface BookingOptionsResponse {
  options: SellerBookingOption[];
  cached: boolean;
  fetchedAt: string;
}

// ── Normalisation ────────────────────────────────────────────────────────────────────────────────

const STAMP_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})/;

/** Provider timestamps (`2026-11-21 09:30`) → `YYYY-MM-DD HH:MM`, or null. */
export function parseStamp(value: unknown): string | null {
  const m = STAMP_RE.exec(typeof value === 'string' ? value : '');
  return m ? `${m[1]} ${m[2].padStart(5, '0')}` : null;
}

/** 32-bit FNV-1a, hex. Good enough to give an itinerary a stable id. */
export function hashKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const BAG_WORDS = /carry-?on|cabin bag|hand bag|baggage|checked bag|bag(s)?\b/i;

/**
 * Baggage and amenities from the fare's `extensions[]` strings. Many fares state no baggage at all,
 * and that is reported as such rather than guessed.
 */
export function summarizeExtensions(extensions: string[]): {
  baggage: BaggageInfo | null;
  baggageSummary: string;
  amenities: string[];
} {
  const texts = extensions.filter((t) => typeof t === 'string' && t.trim().length > 0);
  const baggage = parseBaggage(texts);
  const amenities = texts.filter((t) => !BAG_WORDS.test(t) && !/^carbon emissions/i.test(t.trim()));

  let baggageSummary = 'Baggage not stated';
  if (baggage) {
    const cabin =
      baggage.cabin === 'included'
        ? `1 carry-on${baggage.cabinKg ? ` (${baggage.cabinKg} kg)` : ''}`
        : baggage.cabin === 'fee'
          ? 'Carry-on for a fee'
          : baggage.cabin === 'none'
            ? 'No carry-on'
            : null;
    const checked =
      baggage.checked === 'included'
        ? baggage.checkedPieces && baggage.checkedPieces > 1
          ? `${baggage.checkedPieces} checked bags included`
          : 'Checked bag included'
        : baggage.checked === 'fee'
          ? 'Checked bag for a fee'
          : baggage.checked === 'none'
            ? 'No checked bag'
            : null;
    const parts = [cabin, checked].filter((p): p is string => p !== null);
    // A fare that states only that a checked bag costs extra is a carry-on-only fare in practice
    baggageSummary = parts.length > 0 ? parts.join(' · ') : baggageSummary;
    if (baggage.cabin === 'included' && baggage.checked === 'fee') baggageSummary = 'Carry-on only';
  }
  return { baggage, baggageSummary, amenities };
}

interface RawFlight {
  flight_number?: string;
  airline?: string;
  airline_logo?: string;
  airplane?: string;
  travel_class?: string;
  legroom?: string;
  duration?: number;
  extensions?: string[];
  departure_airport?: { name?: string; id?: string; time?: string };
  arrival_airport?: { name?: string; id?: string; time?: string };
}

interface RawItinerary {
  flights?: RawFlight[];
  layovers?: { id?: string; name?: string; duration?: number; overnight?: boolean }[];
  total_duration?: number;
  price?: number;
  airline_logo?: string;
  extensions?: string[];
  carbon_emissions?: { this_flight?: number };
  booking_token?: string;
  departure_token?: string;
}

/**
 * Turns a SerpApi `best_flights` / `other_flights` response into offers. An itinerary missing its
 * price, duration or flights is dropped, never filled in with an invented value.
 */
export function normalizeSerpFlights(
  data: { best_flights?: RawItinerary[]; other_flights?: RawItinerary[] } | null | undefined,
  ctx: { currency: string; fetchedAt: string }
): LiveFlightOffer[] {
  const groups = [...(data?.best_flights ?? []), ...(data?.other_flights ?? [])];
  const offers: LiveFlightOffer[] = [];

  for (const item of groups) {
    const flights = Array.isArray(item.flights) ? item.flights : [];
    const price = Number(item.price);
    if (flights.length === 0 || !(price > 0)) continue;

    const layovers = (Array.isArray(item.layovers) ? item.layovers : []).map((l) => ({
      airportName: l.name ?? l.id ?? '',
      iata: (l.id ?? '').toUpperCase(),
      durationMinutes: Number(l.duration) || 0,
      overnight: Boolean(l.overnight),
    }));
    const layoverMinutes = layovers.reduce((sum, l) => sum + l.durationMinutes, 0);
    const flightMinutes = flights.reduce((sum, f) => sum + (Number(f.duration) || 0), 0);
    const totalDurationMinutes = Number(item.total_duration) || flightMinutes + layoverMinutes;

    const segments: LiveFlightSegment[] = [];
    for (const f of flights) {
      const dep = parseStamp(f.departure_airport?.time);
      const arr = parseStamp(f.arrival_airport?.time);
      const fromIata = (f.departure_airport?.id ?? '').toUpperCase();
      const toIata = (f.arrival_airport?.id ?? '').toUpperCase();
      if (!dep || !arr || !fromIata || !toIata) break;
      const flightNumber = (f.flight_number ?? '').trim();
      segments.push({
        flightNumber,
        airline: (f.airline ?? '').trim(),
        // "TK 61" → "TK"
        airlineCode: (/^([A-Z0-9]{2})\s*\d/i.exec(flightNumber)?.[1] ?? '').toUpperCase(),
        ...(f.airline_logo ? { airlineLogo: f.airline_logo } : {}),
        fromIata,
        fromName: f.departure_airport?.name ?? fromIata,
        toIata,
        toName: f.arrival_airport?.name ?? toIata,
        departureAt: dep,
        arrivalAt: arr,
        durationMinutes: Number(f.duration) || 0,
        ...(f.airplane ? { airplane: f.airplane } : {}),
        ...(f.travel_class ? { travelClass: f.travel_class } : {}),
        ...(f.legroom ? { legroom: f.legroom } : {}),
      });
    }
    if (segments.length !== flights.length || !(totalDurationMinutes > 0)) continue;

    const first = segments[0];
    const last = segments[segments.length - 1];
    const extensions = [...(item.extensions ?? []), ...flights.flatMap((f) => f.extensions ?? [])];
    const { baggage, baggageSummary, amenities } = summarizeExtensions(extensions);
    const co2 = Number(item.carbon_emissions?.this_flight) / 1000;

    offers.push({
      source: 'serpapi_live',
      id: hashKey(`${segments.map((s) => `${s.flightNumber}@${s.departureAt}`).join('|')}#${price}`),
      airline: {
        name: first.airline,
        iataCode: first.airlineCode,
        ...(item.airline_logo ?? first.airlineLogo ? { logo: item.airline_logo ?? first.airlineLogo } : {}),
      },
      flightNumber: segments.map((s) => s.flightNumber).filter(Boolean).join(' + '),
      departureTime: first.departureAt,
      arrivalTime: last.arrivalAt,
      totalDurationMinutes,
      stopsCount: layovers.length || segments.length - 1,
      layovers,
      segments,
      price,
      currency: ctx.currency,
      baggageSummary,
      ...(baggage ? { baggage } : {}),
      amenities,
      ...(item.booking_token ? { bookingToken: item.booking_token } : {}),
      ...(item.departure_token ? { departureToken: item.departure_token } : {}),
      ...(co2 > 0 ? { co2Kg: Math.round(co2) } : {}),
      fetchedAt: ctx.fetchedAt,
    });
  }
  return offers;
}

// ── Booking options ──────────────────────────────────────────────────────────────────────────────

interface RawSeller {
  book_with?: string;
  airline?: boolean;
  price?: number;
  option_title?: string;
  airline_logos?: string[];
  baggage_prices?: string[];
  booking_request?: { url?: string; post_data?: string };
}

interface RawBookingOption {
  separate_tickets?: boolean;
  together?: RawSeller;
  departing?: RawSeller;
  returning?: RawSeller;
}

/**
 * Sellers of one exact ticket. Handles a single ticket sold `together`, and a ticket sold as two
 * `departing` + `returning` tickets (each part becomes its own row, tied together by `groupId`, with
 * the group's total price). Entries with no price or no https booking url are dropped. The `post_data`
 * string is passed through untouched.
 */
export function parseBookingOptions(
  data: { booking_options?: RawBookingOption[] } | null | undefined
): SellerBookingOption[] {
  const out: SellerBookingOption[] = [];
  const options = Array.isArray(data?.booking_options) ? data!.booking_options! : [];

  const toSeller = (
    raw: RawSeller | undefined
  ): Omit<SellerBookingOption, 'id' | 'groupId' | 'part' | 'separateTickets' | 'groupPrice'> | null => {
    const price = Number(raw?.price);
    // Only an absolute https URL may become a link or a form action (no javascript:/data: URIs)
    const url = safeHttpsUrl(raw?.booking_request?.url);
    if (!raw || !(price > 0) || !url) return null;
    const postData = raw.booking_request?.post_data;
    return {
      bookWith: (raw.book_with ?? '').trim() || 'Seller',
      isAirlineDirect: raw.airline === true,
      price,
      baggagePrices: Array.isArray(raw.baggage_prices) ? raw.baggage_prices.filter((b) => typeof b === 'string') : [],
      ...(raw.option_title ? { optionTitle: raw.option_title } : {}),
      ...(safeHttpsUrl(raw.airline_logos?.[0]) ? { logo: safeHttpsUrl(raw.airline_logos?.[0])! } : {}),
      bookingRequest: { url, ...(typeof postData === 'string' && postData.length > 0 ? { postData } : {}) },
    };
  };

  options.forEach((opt, i) => {
    const groupId = `g${i}`;
    if (opt.together) {
      const s = toSeller(opt.together);
      if (s) out.push({ ...s, id: `${groupId}-t`, groupId, part: 'together', separateTickets: false, groupPrice: s.price });
      return;
    }
    const dep = toSeller(opt.departing);
    const ret = toSeller(opt.returning);
    if (dep && ret) {
      const groupPrice = dep.price + ret.price;
      out.push({ ...dep, id: `${groupId}-d`, groupId, part: 'departing', separateTickets: true, groupPrice });
      out.push({ ...ret, id: `${groupId}-r`, groupId, part: 'returning', separateTickets: true, groupPrice });
    }
  });
  return out;
}

/** Cheapest first; on a tie the airline's own site comes first. Split tickets sort by their total. */
export function sortSellerOptions(options: SellerBookingOption[]): SellerBookingOption[] {
  const order = new Map<string, number>();
  options.forEach((o) => {
    if (!order.has(o.groupId)) order.set(o.groupId, order.size);
  });
  return [...options].sort(
    (a, b) =>
      a.groupPrice - b.groupPrice ||
      Number(b.isAirlineDirect) - Number(a.isAirlineDirect) ||
      (order.get(a.groupId)! - order.get(b.groupId)!) ||
      (a.part === 'returning' ? 1 : 0) - (b.part === 'returning' ? 1 : 0)
  );
}

/**
 * The fields of a `booking_request.post_data` string, in order, decoded once. Rendered as hidden form
 * inputs, the browser encodes them again when the form is submitted, so the body that reaches Google
 * is the original (no double encoding). Repeated names are kept.
 */
export function postDataFields(postData: string): [string, string][] {
  return Array.from(new URLSearchParams(postData).entries());
}

// ── Cache keys and offline links ─────────────────────────────────────────────────────────────────

const norm = (s: string | undefined) => (s ?? '').trim().toUpperCase();

/** One search per corridor, date(s) and currency; the party size is not part of it (prices are per adult). */
export function liveSearchCacheKey(req: LiveSearchRequest): string {
  return [
    'live-flights:v1',
    norm(req.originIata),
    norm(req.destinationIata),
    req.departureDate,
    req.returnDate ?? '-',
    norm(req.currency) || 'USD',
  ].join(':');
}

export function bookingOptionsCacheKey(token: string, currency?: string): string {
  return `live-flights:booking:v1:${norm(currency) || 'USD'}:${hashKey(token)}${token.length.toString(36)}`;
}

/**
 * Exact-route search links for when live fares are unavailable (no key, quota used up): origin,
 * destination and date(s) are prefilled, so the traveller still lands on a working search.
 */
export function offlineFallbackLinks(req: LiveSearchRequest): FallbackLink[] {
  const from = norm(req.originIata);
  const to = norm(req.destinationIata);
  const links: FallbackLink[] = [];
  const trip = buildTripFlightUrl({
    originIata: from,
    destinationIata: to,
    departureDate: req.departureDate,
    tripType: req.returnDate ? 'rt' : 'ow',
    returnDate: req.returnDate,
    passengers: req.adults,
  });
  if (trip) links.push({ name: 'Trip.com', url: trip });

  const yymmdd = (iso: string) => iso.replace(/-/g, '').slice(2);
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.departureDate) && /^[A-Z]{3}$/.test(from) && /^[A-Z]{3}$/.test(to)) {
    const back = req.returnDate && /^\d{4}-\d{2}-\d{2}$/.test(req.returnDate) ? req.returnDate : undefined;
    const sky = new URLSearchParams({
      adultsv2: String(req.adults ?? 1),
      cabinclass: 'economy',
      rtn: back ? '1' : '0',
    });
    links.push({
      name: 'Skyscanner',
      url: `https://www.skyscanner.net/transport/flights/${from.toLowerCase()}/${to.toLowerCase()}/${yymmdd(req.departureDate)}/${back ? `${yymmdd(back)}/` : ''}?${sky.toString()}`,
    });
  }
  return links;
}
