// MUST stay the first import so env is loaded before the Duffel client reads its token
import { getEnv, warnMissingKey } from './env.ts';
import { Duffel } from '@duffel/api';
import type { Offer } from '@duffel/api/types';
import { getRedisClient } from './redis.ts';
import { getRates } from './ratesService.ts';
import { DEFAULT_MARKUP_CONFIG, PricingError, applyDynamicMarkup, type MarkupConfig } from '../shared/pricing.ts';
import type {
  AirportRefDto,
  CabinClass,
  CarrierDto,
  DuffelOfferDto,
  FlightSearchRequest,
  FlightSegmentDto,
  FlightSliceDto,
  LayoverDto,
} from '../shared/flights.ts';

/**
 * Flight search on Duffel (https://duffel.com/docs/api): live, bookable offers (`off_0000…`) with the
 * exact price the airline will charge. The token stays on the server; the browser only ever sees the
 * normalised DTOs from `shared/flights.ts`, whose prices already include our service fee.
 *
 * Offers expire (usually within 15-30 minutes), so they are cached for 10 minutes only, and a cached
 * offer is never served within 2 minutes of its `expires_at`.
 */

export const duffelToken = (): string | undefined => getEnv('DUFFEL_ACCESS_TOKEN');
export const isDuffelConfigured = (): boolean => Boolean(duffelToken());

let client: Duffel | null = null;
function duffel(): Duffel | null {
  const token = duffelToken();
  if (!token) {
    warnMissingKey('DUFFEL_ACCESS_TOKEN', 'live flight search and checkout');
    return null;
  }
  // DUFFEL_BASE_URL points the SDK at another host (a local mock in tests); unset = Duffel's API
  const basePath = getEnv('DUFFEL_BASE_URL');
  client ??= new Duffel({ token, ...(basePath ? { basePath } : {}) });
  return client;
}

// ── Markup configuration (env-tunable) ───────────────────────────────────────────────────────────

function envNumber(name: string, fallback: number, min = 0): number {
  const raw = getEnv(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= min) return n;
  console.warn(`[env] ${name}="${raw}" is not a valid number; using ${fallback}.`);
  return fallback;
}

export function markupConfig(): MarkupConfig {
  return {
    thresholdUsd: DEFAULT_MARKUP_CONFIG.thresholdUsd,
    shortHaulFlatFeeUsd: envNumber('SHORT_HAUL_FLAT_FEE_USD', DEFAULT_MARKUP_CONFIG.shortHaulFlatFeeUsd),
    longHaulMarkupPercent: envNumber('LONG_HAUL_MARKUP_PERCENT', DEFAULT_MARKUP_CONFIG.longHaulMarkupPercent),
  };
}

// ── Normalisation ────────────────────────────────────────────────────────────────────────────────

/** A normalised offer before our fee is added: this is what is cached. */
export interface RawOffer extends Omit<DuffelOfferDto, 'pricing'> {
  /** Duffel's `total_amount` (taxes included, whole party). */
  baseAmount: number;
  currency: string;
}

/** `PT20H10M` / `P1DT2H` → minutes. */
export function parseIsoDuration(value: string | null | undefined): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(value ?? '');
  if (!m) return 0;
  return (Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0);
}

const localMs = (iso: string) => Date.parse(`${iso.slice(0, 19)}Z`);

const carrierDto = (a: {
  name: string;
  iata_code: string | null;
  logo_symbol_url?: string | null;
}): CarrierDto => ({
  name: a.name,
  iataCode: a.iata_code ?? '',
  ...(a.logo_symbol_url ? { logoUrl: a.logo_symbol_url } : {}),
});

const airportDto = (a: { iata_code: string | null; name: string; city_name?: string | null }): AirportRefDto => ({
  iataCode: a.iata_code ?? '',
  name: a.name,
  ...(a.city_name ? { city: a.city_name } : {}),
});

export function normalizeOffer(offer: Pick<Offer, 'id' | 'expires_at' | 'owner' | 'slices' | 'total_amount' | 'total_currency' | 'passengers'>): RawOffer | null {
  const amount = Number(offer.total_amount);
  if (!(amount > 0) || !offer.total_currency || !Array.isArray(offer.slices) || offer.slices.length === 0) return null;

  const slices: FlightSliceDto[] = [];
  for (const slice of offer.slices) {
    const segs = slice.segments ?? [];
    if (segs.length === 0) return null;
    const segments: FlightSegmentDto[] = segs.map((s) => {
      const marketing = carrierDto(s.marketing_carrier);
      const operating = carrierDto(s.operating_carrier);
      return {
        flightNumber: `${marketing.iataCode} ${s.marketing_carrier_flight_number}`.trim(),
        carrier: marketing,
        ...(operating.iataCode && operating.iataCode !== marketing.iataCode ? { operatingCarrier: operating } : {}),
        origin: airportDto(s.origin),
        destination: airportDto(s.destination),
        departureAt: s.departing_at,
        arrivalAt: s.arriving_at,
        durationMinutes: parseIsoDuration(s.duration),
        ...(s.aircraft?.name ? { aircraft: s.aircraft.name } : {}),
      };
    });
    const layovers: LayoverDto[] = [];
    for (let i = 0; i < segments.length - 1; i++) {
      const minutes = Math.max(0, Math.round((localMs(segments[i + 1].departureAt) - localMs(segments[i].arrivalAt)) / 60000));
      layovers.push({
        airport: segments[i].destination,
        minutes,
        // Waiting across the night: more than 6h that spans local midnight
        overnight:
          minutes > 360 && segments[i].arrivalAt.slice(0, 10) !== segments[i + 1].departureAt.slice(0, 10),
      });
    }
    const first = segments[0];
    const last = segments[segments.length - 1];
    const total = parseIsoDuration(slice.duration);
    slices.push({
      origin: first.origin,
      destination: last.destination,
      departureAt: first.departureAt,
      arrivalAt: last.arrivalAt,
      durationMinutes:
        total ||
        segments.reduce((sum, s) => sum + s.durationMinutes, 0) + layovers.reduce((sum, l) => sum + l.minutes, 0),
      segments,
      layovers,
    });
  }

  const cabin = offer.slices[0].segments[0].passengers?.[0]?.cabin_class as CabinClass | undefined;
  return {
    source: 'duffel',
    offerId: offer.id,
    expiresAt: offer.expires_at,
    owner: carrierDto(offer.owner),
    ...(cabin ? { cabinClass: cabin } : {}),
    passengers: Math.max(1, offer.passengers?.length ?? 1),
    slices,
    baseAmount: amount,
    currency: offer.total_currency.toUpperCase(),
  };
}

/**
 * Adds our service fee. Offers in a currency with no exchange rate cannot be tiered, so they are
 * dropped (and counted in the log) instead of being priced by guesswork.
 */
export async function priceOffers(raw: RawOffer[]): Promise<DuffelOfferDto[]> {
  const [rates, config] = [(await getRates()).rates, markupConfig()];
  const out: DuffelOfferDto[] = [];
  let dropped = 0;
  for (const { baseAmount, currency, ...offer } of raw) {
    try {
      out.push({ ...offer, pricing: applyDynamicMarkup(baseAmount, currency, config, rates) });
    } catch (err) {
      if (!(err instanceof PricingError)) throw err;
      dropped++;
    }
  }
  if (dropped > 0) console.warn(`[Duffel] ${dropped} offer(s) skipped: no exchange rate for their currency.`);
  return out;
}

// ── 10-minute offer cache (memory + Upstash Redis) ───────────────────────────────────────────────

export const OFFER_CACHE_TTL_SECONDS = 600;
/** A cached offer this close to expiring is not served: the traveller could not finish booking it. */
export const MIN_OFFER_LIFETIME_MS = 2 * 60 * 1000;
const MAX_OFFERS_KEPT = 40;
const MEMORY_MAX = 100;
const memory = new Map<string, { expires: number; offers: RawOffer[] }>();

export function offerCacheKey(req: FlightSearchRequest): string {
  const slices = req.slices
    .map((s) => `${s.origin.trim().toUpperCase()}-${s.destination.trim().toUpperCase()}-${s.departureDate}`)
    .join('|');
  return `duffel:offers:v1:${slices}:${req.passengers}:${req.cabinClass ?? 'any'}`;
}

/** Offers that still have enough life left to be booked. */
export function stillBookable<T extends { expiresAt: string }>(offers: T[], now = Date.now()): T[] {
  return offers.filter((o) => Date.parse(o.expiresAt) - now > MIN_OFFER_LIFETIME_MS);
}

async function readCache(key: string): Promise<RawOffer[] | null> {
  const mem = memory.get(key);
  if (mem && mem.expires > Date.now()) {
    const fresh = stillBookable(mem.offers);
    if (fresh.length > 0) return fresh;
  }
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const hit = await redis.get<RawOffer[]>(key);
    if (Array.isArray(hit)) {
      const fresh = stillBookable(hit);
      if (fresh.length > 0) return fresh;
    }
  } catch (err) {
    console.warn(`[Duffel] Redis read failed for ${key}:`, err);
  }
  return null;
}

async function writeCache(key: string, offers: RawOffer[]): Promise<void> {
  if (memory.size >= MEMORY_MAX) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(key, { expires: Date.now() + OFFER_CACHE_TTL_SECONDS * 1000, offers });
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.set(key, offers, { ex: OFFER_CACHE_TTL_SECONDS });
  } catch (err) {
    console.warn(`[Duffel] Redis write failed for ${key}:`, err);
  }
}

// ── Search ───────────────────────────────────────────────────────────────────────────────────────

const IATA_RE = /^[A-Za-z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Returns an error message for a malformed search request, or null when it is fine. */
export function validateSearch(req: Partial<FlightSearchRequest> | null | undefined): string | null {
  if (!req || !Array.isArray(req.slices) || req.slices.length < 1 || req.slices.length > 6) {
    return 'Provide 1 to 6 slices.';
  }
  for (const s of req.slices) {
    if (!IATA_RE.test(s?.origin ?? '') || !IATA_RE.test(s?.destination ?? '')) return 'origin and destination must be 3-letter IATA codes.';
    if (s.origin.toUpperCase() === s.destination.toUpperCase()) return 'origin and destination must differ.';
    if (!DATE_RE.test(s.departureDate ?? '')) return 'departureDate must be YYYY-MM-DD.';
  }
  if (!Number.isInteger(req.passengers) || (req.passengers as number) < 1 || (req.passengers as number) > 9) {
    return 'passengers must be a whole number from 1 to 9.';
  }
  return null;
}

/**
 * Searches Duffel (offer request with `return_offers`), caching for 10 minutes. Returns null when
 * Duffel is not configured or the search failed, so callers can fall back.
 */
export async function searchDuffelOffers(
  req: FlightSearchRequest
): Promise<{ offers: DuffelOfferDto[]; cached: boolean } | null> {
  const key = offerCacheKey(req);
  const cached = await readCache(key);
  if (cached) {
    console.log(`[Duffel] Cache HIT ${key} (${cached.length} offers)`);
    return { offers: await priceOffers(cached), cached: true };
  }

  const api = duffel();
  if (!api) return null;

  try {
    console.log(`[Duffel] Searching ${req.slices.map((s) => `${s.origin}-${s.destination} ${s.departureDate}`).join(', ')} x${req.passengers}`);
    const res = await api.offerRequests.create({
      slices: req.slices.map((s) => ({
        origin: s.origin.toUpperCase(),
        destination: s.destination.toUpperCase(),
        departure_date: s.departureDate,
        arrival_time: null,
        departure_time: null,
      })),
      passengers: Array.from({ length: req.passengers }, () => ({ type: 'adult' as const })),
      ...(req.cabinClass ? { cabin_class: req.cabinClass } : {}),
      return_offers: true,
      supplier_timeout: 15000,
    });
    const raw = (res.data.offers ?? [])
      .map((o) => normalizeOffer(o))
      .filter((o): o is RawOffer => o !== null)
      .sort((a, b) => a.baseAmount - b.baseAmount)
      .slice(0, MAX_OFFERS_KEPT);
    if (raw.length === 0) {
      console.log('[Duffel] No offers returned.');
      return { offers: [], cached: false };
    }
    await writeCache(key, raw);
    return { offers: await priceOffers(raw), cached: false };
  } catch (err) {
    console.warn('[Duffel] Offer request failed:', describeDuffelError(err));
    return null;
  }
}

export type LiveOfferResult =
  | { status: 'ok'; offer: RawOffer }
  | { status: 'expired' }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

/** Fetches the live offer and checks it can still be booked. */
export async function getLiveOffer(offerId: string): Promise<LiveOfferResult> {
  const api = duffel();
  if (!api) return { status: 'error', message: 'Flight booking is not configured.' };
  try {
    const res = await api.offers.get(offerId);
    const raw = normalizeOffer(res.data);
    if (!raw) return { status: 'error', message: 'The offer could not be read.' };
    if (Date.parse(raw.expiresAt) <= Date.now()) return { status: 'expired' };
    return { status: 'ok', offer: raw };
  } catch (err) {
    const e = err as { meta?: { status?: number }; errors?: { code?: string }[] };
    if (e?.meta?.status === 404 || e?.errors?.some((x) => x.code === 'not_found')) return { status: 'not_found' };
    if (e?.errors?.some((x) => x.code === 'offer_no_longer_available')) return { status: 'expired' };
    return { status: 'error', message: describeDuffelError(err) };
  }
}

/** The order Duffel issued (authoritative: fetched with our token), or null when it cannot be read. */
export async function getOrderSummary(orderId: string): Promise<{ id: string; bookingReference?: string } | null> {
  const api = duffel();
  if (!api) return null;
  try {
    const res = await api.orders.get(orderId);
    return { id: res.data.id, bookingReference: res.data.booking_reference ?? undefined };
  } catch (err) {
    console.warn(`[Duffel] could not read order ${orderId}:`, describeDuffelError(err));
    return null;
  }
}

export function describeDuffelError(err: unknown): string {
  const e = err as { errors?: { title?: string; message?: string; code?: string }[]; message?: string };
  if (Array.isArray(e?.errors) && e.errors.length > 0) {
    return e.errors.map((x) => `${x.code ?? 'error'}: ${x.message ?? x.title ?? ''}`).join('; ');
  }
  return e?.message ?? String(err);
}

// ── Links (hosted checkout) ──────────────────────────────────────────────────────────────────────

export interface LinkSessionInput {
  reference: string;
  successUrl: string;
  failureUrl: string;
  abandonmentUrl: string;
  markupAmount: number;
  markupCurrency: string;
  logoUrl?: string;
  checkoutText?: string;
}

/**
 * Creates a Duffel Links session (hosted search, payment and ticketing; PCI scope stays with Duffel).
 * Returns the URL to send the traveller to.
 */
export async function createLinkSession(input: LinkSessionInput): Promise<string> {
  const api = duffel();
  if (!api) throw new Error('Flight booking is not configured.');
  const res = await api.links.create({
    reference: input.reference,
    success_url: input.successUrl,
    failure_url: input.failureUrl,
    abandonment_url: input.abandonmentUrl,
    primary_color: '#EA580C',
    ...(input.logoUrl ? { logo_url: input.logoUrl } : {}),
    markup_amount: input.markupAmount,
    markup_currency: input.markupCurrency,
    ...(input.checkoutText ? { checkout_display_text: input.checkoutText } : {}),
  });
  return res.data.url;
}
