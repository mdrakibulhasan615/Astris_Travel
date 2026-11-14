import type { BookingProvider, TransitOption } from './types.ts';
import { toAirportCode, toMetroCode } from './airports.ts';

/**
 * Direct merchant deep links (ARCHITECTURE.md §6). Every link lands on the site that sells the
 * ticket or room, with the search already filled in from the card the user clicked. There is no
 * metasearch page in between.
 *
 *   flight        → Trip.com flight results   (city + airport, date, passengers, airline)
 *   FlixBus coach → FlixBus shop search       (city ids, date, passengers)
 *   train, ferry, other coaches → 12Go        (city slugs, date, passengers)
 *   stay          → Booking.com and Agoda     (city, check-in/out, guests, rooms, property filter)
 *
 * Each URL format below was checked against the live site; the parameters are the ones the
 * merchant's own search form produces. Attribution is either the merchant's own partner
 * parameter (appended to the same URL) or, for programs that run through a network such as
 * Awin or Travelpayouts, an optional tracking template that wraps the finished deep link.
 *
 * Pure and dependency-free: the server configures ids from the environment, the browser gets the
 * same ids from `GET /api/affiliate/config` (they are public: every outbound link carries them).
 */

export const PROVIDER_NAMES: Record<BookingProvider, string> = {
  tripcom: 'Trip.com',
  flixbus: 'FlixBus',
  '12go': '12Go',
  booking: 'Booking.com',
  agoda: 'Agoda',
};

export interface AffiliateConfig {
  /** Trip.com affiliate pair, sent as `Allianceid` + `SID`. Both are needed for attribution. */
  tripcomAllianceId?: string;
  tripcomSid?: string;
  /** Booking.com affiliate id, sent as `aid`. */
  bookingAid?: string;
  /** Agoda partner id, sent as `cid`. */
  agodaCid?: string;
  /** 12Go partner id, sent as `z`. */
  twelveGoAffiliateId?: string;
  /**
   * Per-merchant tracking wrapper for network-run programs, e.g.
   * `https://www.awin1.com/cread.php?awinmid=1&awinaffid=2&ued={url}`. `{url}` is replaced with
   * the URL-encoded deep link, so the click still lands on the exact merchant page.
   */
  trackingTemplates?: Partial<Record<BookingProvider, string>>;
  /** Log every distinct generated URL (development only; set by the server). */
  debug?: boolean;
}

const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const IATA_RE = /^[A-Za-z]{3}$/;
const AIRLINE_RE = /^[A-Z0-9]{2}$/;
const PROVIDERS = Object.keys(PROVIDER_NAMES) as BookingProvider[];

let activeConfig: AffiliateConfig = {};
const loggedUrls = new Set<string>();

function warn(message: string): void {
  console.warn(`[Affiliate] ${message}`);
}

function validId(value: string | undefined, label: string): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (!ID_RE.test(v)) {
    warn(`${label} has an invalid format and was ignored (allowed pattern: ${ID_RE.source}).`);
    return undefined;
  }
  return v;
}

function validTemplate(value: string | undefined, label: string): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  let ok = false;
  try {
    ok = new URL(v.replace('{url}', 'x')).protocol === 'https:' && v.includes('{url}');
  } catch {
    ok = false;
  }
  if (!ok) {
    warn(`${label} must be an https URL containing the {url} placeholder; it was ignored.`);
    return undefined;
  }
  return v;
}

/** Validates and installs the partner ids. Invalid values are dropped with a warning. */
export function configureAffiliate(config: AffiliateConfig): void {
  const trackingTemplates: Partial<Record<BookingProvider, string>> = {};
  for (const provider of PROVIDERS) {
    const template = validTemplate(
      config.trackingTemplates?.[provider],
      `${PROVIDER_NAMES[provider]} tracking template`
    );
    if (template) trackingTemplates[provider] = template;
  }
  activeConfig = {
    tripcomAllianceId: validId(config.tripcomAllianceId, 'TRIPCOM_ALLIANCE_ID'),
    tripcomSid: validId(config.tripcomSid, 'TRIPCOM_SID'),
    bookingAid: validId(config.bookingAid, 'BOOKING_AID'),
    agodaCid: validId(config.agodaCid, 'AGODA_CID'),
    twelveGoAffiliateId: validId(config.twelveGoAffiliateId, 'TWELVEGO_AFFILIATE_ID'),
    trackingTemplates,
    debug: Boolean(config.debug),
  };
  if (Boolean(activeConfig.tripcomAllianceId) !== Boolean(activeConfig.tripcomSid)) {
    warn('Trip.com needs both TRIPCOM_ALLIANCE_ID and TRIPCOM_SID; flight links are not attributed.');
  }
  loggedUrls.clear();
  if (activeConfig.debug) {
    console.log(
      `[Affiliate] attribution: ${PROVIDERS.map(
        (p) => `${PROVIDER_NAMES[p]}=${isProviderAttributed(p) ? 'on' : 'off'}`
      ).join(' ')}`
    );
  }
}

/** The validated ids, safe to hand to the browser (none of them is a secret). */
export function getPublicAffiliateConfig(): AffiliateConfig {
  const { debug: _debug, ...publicConfig } = activeConfig;
  return publicConfig;
}

/** True when links to this merchant carry our partner id (directly or via a tracking template). */
export function isProviderAttributed(provider: BookingProvider): boolean {
  if (activeConfig.trackingTemplates?.[provider]) return true;
  switch (provider) {
    case 'tripcom':
      return Boolean(activeConfig.tripcomAllianceId && activeConfig.tripcomSid);
    case 'booking':
      return Boolean(activeConfig.bookingAid);
    case 'agoda':
      return Boolean(activeConfig.agodaCid);
    case '12go':
      return Boolean(activeConfig.twelveGoAffiliateId);
    default:
      return false;
  }
}

/** Wraps a finished deep link in the merchant's tracking template, when one is configured. */
function track(provider: BookingProvider, url: string): string {
  const template = activeConfig.trackingTemplates?.[provider];
  return template ? template.replace('{url}', encodeURIComponent(url)) : url;
}

interface DateParts {
  y: number;
  m: number;
  d: number;
}

/** Parses `YYYY-MM-DD[...]` into validated parts; rejects impossible dates like 2026-02-31. */
function parseIsoDate(value: string | undefined): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec((value ?? '').trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    return null;
  }
  return { y, m, d };
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const isoDate = (p: DateParts) => `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
const utcDay = (p: DateParts) => Date.UTC(p.y, p.m - 1, p.d);

function clampCount(value: unknown, max: number): number {
  return Math.min(max, Math.max(1, Math.floor(Number(value ?? 1)) || 1));
}

/** `São Paulo` → `sao-paulo`: the route slug 12Go uses. Empty when nothing usable is left. */
export function citySlug(name: string | undefined): string {
  return (name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Transport ─────────────────────────────────────────────────────────────────────────────────

export interface BookingContext {
  /** The leg's stop codes (airport or metro). The option's own segments take precedence. */
  fromCode: string;
  toCode: string;
  fromCity?: string;
  toCity?: string;
  /** Departure date, `YYYY-MM-DD` (a trailing time component is tolerated). */
  date?: string;
  /** Travellers (1–9). */
  passengers?: number;
  /** FlixBus city ids for both ends, resolved server-side. Absent → FlixBus is not offered. */
  flixbus?: { fromCityId: string; toCityId: string } | null;
}

export interface BookingLink {
  url: string;
  provider: BookingProvider;
}

type LinkableOption = Pick<TransitOption, 'mode'> &
  Partial<
    Pick<
      TransitOption,
      | 'carrier'
      | 'carrierCode'
      | 'routeCode'
      | 'flightNumbers'
      | 'segments'
      | 'departureAt'
      | 'dataSource'
    >
  >;

/** FlixBus sells FlixBus (and FlixTrain) only; other coach brands go to a multi-operator merchant. */
export function isFlixCarrier(option: Pick<TransitOption, 'carrier' | 'carrierCode'>): boolean {
  return option.carrierCode === 'FX' || /flix/i.test(option.carrier ?? '');
}

/**
 * The airports this exact ticket uses. A London stop is `LON`, but the selected fare may leave
 * from Stansted: the first and last flight segments say which, and the link must match them.
 */
function ticketAirports(option: LinkableOption, ctx: BookingContext): { from: string; to: string } {
  const flights = (option.segments ?? []).filter((s) => s.mode === 'flight');
  const first = flights[0]?.fromCode;
  const last = flights[flights.length - 1]?.toCode;
  return {
    from: (first && IATA_RE.test(first) ? first : toAirportCode(ctx.fromCode)).toUpperCase(),
    to: (last && IATA_RE.test(last) ? last : toAirportCode(ctx.toCode)).toUpperCase(),
  };
}

/**
 * The single airline that operates the whole ticket, or null. Estimated options use made-up
 * services, and a codeshare/interline ticket has no single airline to filter by; filtering either
 * would land the user on an empty result page.
 */
function ticketAirline(option: LinkableOption): string | null {
  if (option.dataSource === 'synthesized') return null;
  const numbers =
    option.flightNumbers && option.flightNumbers.length > 0
      ? option.flightNumbers
      : (option.routeCode ?? '').split(/[+/,]/);
  const codes = new Set<string>();
  for (const number of numbers) {
    const code = /^\s*([A-Z0-9]{2})\s*\d/i.exec(number)?.[1]?.toUpperCase();
    if (!code) return null;
    codes.add(code);
  }
  if (codes.size !== 1) return null;
  const [code] = [...codes];
  return AIRLINE_RE.test(code) && code === (option.carrierCode ?? code).toUpperCase() ? code : null;
}

/** Appends Trip.com's own partner parameters. */
function tripcomAttribution(params: URLSearchParams): void {
  if (activeConfig.tripcomAllianceId && activeConfig.tripcomSid) {
    params.set('Allianceid', activeConfig.tripcomAllianceId);
    params.set('SID', activeConfig.tripcomSid);
  }
}

/**
 * Trip.com one-way flight results, e.g.
 * `…/flights/showfarefirst?dcity=ist&acity=lon&dairport=saw&aairport=stn&ddate=2026-11-26&triptype=ow&class=y&quantity=2&airline=PC`
 * `dcity`/`acity` are metropolitan codes; `dairport`/`aairport` pin the airport when the city has
 * several. Returns null when the codes or the date cannot form a valid search.
 */
export function buildTripcomFlightUrl(option: LinkableOption, ctx: BookingContext): string | null {
  // The provider's own departure timestamp is the ticket's date; the leg date is the fallback
  const date = parseIsoDate(option.departureAt) ?? parseIsoDate(ctx.date);
  const { from, to } = ticketAirports(option, ctx);
  if (!date || !IATA_RE.test(from) || !IATA_RE.test(to)) return null;

  const fromCity = toMetroCode(from);
  const toCity = toMetroCode(to);
  if (fromCity === toCity) return null;

  const params = new URLSearchParams({ dcity: fromCity.toLowerCase(), acity: toCity.toLowerCase() });
  if (from !== fromCity) params.set('dairport', from.toLowerCase());
  if (to !== toCity) params.set('aairport', to.toLowerCase());
  params.set('ddate', isoDate(date));
  params.set('triptype', 'ow');
  params.set('class', 'y');
  params.set('quantity', String(clampCount(ctx.passengers, 9)));
  const airline = ticketAirline(option);
  if (airline) params.set('airline', airline);
  params.set('locale', 'en-US');
  params.set('curr', 'USD');
  tripcomAttribution(params);
  return `https://www.trip.com/flights/showfarefirst?${params.toString()}`;
}

function tripcomFlightsHome(): string {
  const params = new URLSearchParams({ locale: 'en-US', curr: 'USD' });
  tripcomAttribution(params);
  return `https://www.trip.com/flights/?${params.toString()}`;
}

/**
 * FlixBus shop results:
 * `https://shop.flixbus.com/search?departureCity={uuid}&arrivalCity={uuid}&rideDate=30.11.2026&adult=2`
 * FlixBus only accepts its own city ids, which the server looks up (`server/flixbusService.ts`).
 */
export function buildFlixbusUrl(ctx: BookingContext): string | null {
  const date = parseIsoDate(ctx.date);
  if (!date || !ctx.flixbus?.fromCityId || !ctx.flixbus.toCityId) return null;
  const params = new URLSearchParams({
    departureCity: ctx.flixbus.fromCityId,
    arrivalCity: ctx.flixbus.toCityId,
    rideDate: `${pad2(date.d)}.${pad2(date.m)}.${date.y}`,
    adult: String(clampCount(ctx.passengers, 9)),
    _locale: 'en',
  });
  return `https://shop.flixbus.com/search?${params.toString()}`;
}

/**
 * 12Go route results (trains, coaches, ferries):
 * `https://12go.asia/en/travel/london/paris?date=2026-11-30&people=2`
 */
export function buildTwelveGoUrl(ctx: BookingContext): string | null {
  const date = parseIsoDate(ctx.date);
  const from = citySlug(ctx.fromCity);
  const to = citySlug(ctx.toCity);
  if (!date || !from || !to || from === to) return null;
  const params = new URLSearchParams({
    date: isoDate(date),
    people: String(clampCount(ctx.passengers, 9)),
  });
  if (activeConfig.twelveGoAffiliateId) params.set('z', activeConfig.twelveGoAffiliateId);
  return `https://12go.asia/en/travel/${from}/${to}?${params.toString()}`;
}

function twelveGoHome(): string {
  return activeConfig.twelveGoAffiliateId
    ? `https://12go.asia/en?z=${encodeURIComponent(activeConfig.twelveGoAffiliateId)}`
    : 'https://12go.asia/en';
}

function debugLog(link: BookingLink, ctx: BookingContext, note: string): void {
  if (!activeConfig.debug || loggedUrls.has(link.url)) return;
  if (loggedUrls.size > 500) loggedUrls.clear();
  loggedUrls.add(link.url);
  console.log(
    `[Affiliate] ${PROVIDER_NAMES[link.provider]} ${ctx.fromCode}→${ctx.toCode} ` +
      `date=${ctx.date ?? '-'} pax=${ctx.passengers ?? 1}${note}\n    ${link.url}`
  );
}

/**
 * Builds the outbound link for one option. Never throws and never returns an empty URL: when the
 * route or date cannot form a search, the link goes to the merchant's own search page instead.
 */
export function buildBookingLink(option: LinkableOption, ctx: BookingContext): BookingLink {
  let link: BookingLink;
  let note = '';

  if (option.mode === 'flight') {
    const url = buildTripcomFlightUrl(option, ctx);
    if (!url) note = ' (invalid route/date: merchant search page)';
    link = { provider: 'tripcom', url: track('tripcom', url ?? tripcomFlightsHome()) };
  } else {
    const flixUrl =
      option.mode === 'bus' && isFlixCarrier({ carrier: option.carrier ?? '', carrierCode: option.carrierCode ?? '' })
        ? buildFlixbusUrl(ctx)
        : null;
    if (flixUrl) {
      link = { provider: 'flixbus', url: track('flixbus', flixUrl) };
    } else {
      const url = buildTwelveGoUrl(ctx);
      if (!url) note = ' (invalid route/date: merchant search page)';
      link = { provider: '12go', url: track('12go', url ?? twelveGoHome()) };
    }
  }

  debugLog(link, ctx, note);
  return link;
}

/**
 * Returns copies of `options` with `bookingUrl`/`bookingProvider` populated (overwriting stale
 * values so config, date, route and passenger changes always take effect). Inputs are not mutated.
 */
export function attachBookingUrls(options: TransitOption[], ctx: BookingContext): TransitOption[] {
  return options.map((option) => {
    const link = buildBookingLink(option, ctx);
    return { ...option, bookingUrl: link.url, bookingProvider: link.provider };
  });
}

// ── Stays ─────────────────────────────────────────────────────────────────────────────────────

export interface StayLinkContext {
  city: string;
  country?: string;
  /** `YYYY-MM-DD`; check-out must be after check-in. */
  checkIn: string;
  checkOut: string;
  adults: number;
  rooms: number;
  /** Narrow the results to what the card describes. */
  filter?: {
    starClass?: number;
    propertyType?: 'hotel' | 'hostel' | 'apartment';
  };
}

// Booking.com property-type filter ids (`nflt=ht_id=…`)
const BOOKING_PROPERTY_TYPE = { hotel: 204, hostel: 203, apartment: 201 } as const;

function stayDates(ctx: StayLinkContext): { checkIn: DateParts; checkOut: DateParts; nights: number } | null {
  const checkIn = parseIsoDate(ctx.checkIn);
  const checkOut = parseIsoDate(ctx.checkOut);
  if (!checkIn || !checkOut) return null;
  const nights = Math.round((utcDay(checkOut) - utcDay(checkIn)) / 86_400_000);
  return nights >= 1 ? { checkIn, checkOut, nights } : null;
}

/**
 * Booking.com search results:
 * `…/searchresults.html?ss=Paris%2C+France&checkin=2026-11-30&checkout=2026-12-04&group_adults=2&no_rooms=1&nflt=class%3D4%3Bht_id%3D204&aid=…`
 */
export function buildBookingStayUrl(ctx: StayLinkContext): string | null {
  const dates = stayDates(ctx);
  const city = ctx.city?.trim();
  if (!dates || !city) return null;

  const params = new URLSearchParams({
    ss: ctx.country?.trim() ? `${city}, ${ctx.country.trim()}` : city,
    checkin: isoDate(dates.checkIn),
    checkout: isoDate(dates.checkOut),
    group_adults: String(clampCount(ctx.adults, 30)),
    no_rooms: String(clampCount(ctx.rooms, 30)),
    group_children: '0',
  });
  const filters: string[] = [];
  if (ctx.filter?.starClass) filters.push(`class=${ctx.filter.starClass}`);
  if (ctx.filter?.propertyType) filters.push(`ht_id=${BOOKING_PROPERTY_TYPE[ctx.filter.propertyType]}`);
  if (filters.length > 0) params.set('nflt', filters.join(';'));
  params.set('selected_currency', 'USD');
  if (activeConfig.bookingAid) params.set('aid', activeConfig.bookingAid);
  return track('booking', `https://www.booking.com/searchresults.html?${params.toString()}`);
}

/**
 * Agoda's search takes a numeric city id and nothing else (free text and coordinates are
 * rejected), so only cities in this table get an Agoda link. Ids read from Agoda's own city pages.
 */
// prettier-ignore
const AGODA_CITY_IDS: Record<string, number> = {
  'abu dhabi': 10182, amsterdam: 13868, antalya: 7493, athens: 16571, bali: 17193, denpasar: 17193,
  bangkok: 9395, barcelona: 2002, beijing: 1569, berlin: 2366, brussels: 15904, budapest: 10647,
  cairo: 7923, chicago: 13899, copenhagen: 16480, doha: 4472, dubai: 2994, dublin: 1131,
  edinburgh: 18924, florence: 16573, frankfurt: 15847, hamburg: 7169, hanoi: 2758, helsinki: 11154,
  'ho chi minh city': 13170, 'hong kong': 16808, istanbul: 14932, izmir: 13183, jakarta: 8691,
  jeddah: 9777, krakow: 15790, 'kuala lumpur': 14524, kyoto: 1784, lisbon: 16364, london: 233,
  'los angeles': 12772, lyon: 11361, madrid: 5531, manchester: 12349, manila: 1622, milan: 16585,
  mumbai: 16850, munich: 16017, 'new york': 318, nice: 5277, osaka: 9590, oslo: 12746,
  paris: 15470, penang: 16087, phuket: 16056, porto: 8738, prague: 15977, rome: 16594,
  'san francisco': 13801, seoul: 14690, seville: 16577, shanghai: 3987, singapore: 4064,
  stockholm: 1618, taipei: 4951, tokyo: 5085, toronto: 4495, venice: 17164, vienna: 16582,
  warsaw: 16587, zurich: 16462,
};

export function agodaCityId(city: string | undefined): number | null {
  const key = citySlug(city).replace(/-/g, ' ');
  return AGODA_CITY_IDS[key] ?? null;
}

/**
 * Agoda search results:
 * `https://www.agoda.com/search?city=15470&checkIn=2026-11-30&checkOut=2026-12-04&los=4&rooms=1&adults=2&cid=…`
 * Returns null for cities without a known Agoda id rather than linking somewhere approximate.
 */
export function buildAgodaStayUrl(ctx: StayLinkContext): string | null {
  const dates = stayDates(ctx);
  const cityId = agodaCityId(ctx.city);
  if (!dates || !cityId) return null;

  const params = new URLSearchParams({
    city: String(cityId),
    checkIn: isoDate(dates.checkIn),
    checkOut: isoDate(dates.checkOut),
    los: String(dates.nights),
    rooms: String(clampCount(ctx.rooms, 9)),
    adults: String(clampCount(ctx.adults, 36)),
    children: '0',
    currency: 'USD',
  });
  if (activeConfig.agodaCid) params.set('cid', activeConfig.agodaCid);
  return track('agoda', `https://www.agoda.com/search?${params.toString()}`);
}
