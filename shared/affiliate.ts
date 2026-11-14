import type { TransitOption } from './types.ts';

/**
 * Affiliate booking deep links (ARCHITECTURE.md §3, "Affiliate Monetization").
 *
 * Flights  → Aviasales search deep link, wrapped in a Travelpayouts `tp.media` redirect when a
 *            marker is configured, so clicks are attributed to our partner account (CPA/CPC).
 * Ground   → Rome2Rio route page (no affiliate wrapper; trains/buses/ferries have no partner
 *            program wired up yet).
 * Fallback → Google Flights search when the route or date can't form a valid Aviasales path.
 *
 * Pure and dependency-free so it runs on both server (with credentials configured) and client
 * (unconfigured → plain, un-attributed links that the server later replaces).
 */

export interface AffiliateConfig {
  /** Travelpayouts partner marker (public id appended to outbound links). */
  marker?: string;
  /** Optional sub-id / traffic source tag (`trs`) from the Travelpayouts dashboard. */
  trs?: string;
  /** Travelpayouts campaign id for the Aviasales program. */
  campaignId?: string;
  /** Travelpayouts program id (`p`) for Aviasales. */
  programId?: string;
}

export interface BookingContext {
  fromCode: string;
  toCode: string;
  fromCity?: string;
  toCity?: string;
  /** ISO `YYYY-MM-DD` departure date. */
  date?: string;
  passengers?: number;
}

// Aviasales (campaign 100 / program 4114) — verify against your Travelpayouts dashboard.
const DEFAULT_CAMPAIGN_ID = '100';
const DEFAULT_PROGRAM_ID = '4114';

let activeConfig: AffiliateConfig = {};

/** Called once on the server at startup with values read from the environment. */
export function configureAffiliate(config: AffiliateConfig): void {
  activeConfig = {
    marker: config.marker?.trim() || undefined,
    trs: config.trs?.trim() || undefined,
    campaignId: config.campaignId?.trim() || undefined,
    programId: config.programId?.trim() || undefined,
  };
}

export function isAffiliateConfigured(): boolean {
  return Boolean(activeConfig.marker);
}

const IATA_RE = /^[A-Za-z]{3}$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function aviasalesSearchUrl(ctx: BookingContext): string | null {
  const date = ISO_DATE_RE.exec(ctx.date ?? '');
  if (!date || !IATA_RE.test(ctx.fromCode) || !IATA_RE.test(ctx.toCode)) return null;
  const pax = Math.min(9, Math.max(1, Math.floor(ctx.passengers ?? 1) || 1));
  // Aviasales path format: {ORIGIN}{DDMM}{DEST}{passengers}, e.g. KUL2111IST1
  return `https://www.aviasales.com/search/${ctx.fromCode.toUpperCase()}${date[3]}${date[2]}${ctx.toCode.toUpperCase()}${pax}`;
}

function googleFlightsUrl(ctx: BookingContext): string {
  const date = ISO_DATE_RE.test(ctx.date ?? '') ? ` on ${ctx.date}` : '';
  const q = `Flights from ${ctx.fromCity || ctx.fromCode} to ${ctx.toCity || ctx.toCode}${date}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

function rome2rioUrl(ctx: BookingContext): string {
  const slug = (s: string) => encodeURIComponent(s.trim().replace(/\s+/g, '-'));
  return `https://www.rome2rio.com/map/${slug(ctx.fromCity || ctx.fromCode)}/${slug(ctx.toCity || ctx.toCode)}`;
}

/** Wraps a destination URL in a Travelpayouts tracking redirect when a marker is configured. */
export function wrapAffiliateUrl(targetUrl: string, config: AffiliateConfig = activeConfig): string {
  if (!config.marker) return targetUrl;
  const params = new URLSearchParams({
    marker: config.marker,
    p: config.programId || DEFAULT_PROGRAM_ID,
    campaign_id: config.campaignId || DEFAULT_CAMPAIGN_ID,
    u: targetUrl,
  });
  if (config.trs) params.set('trs', config.trs);
  return `https://tp.media/r?${params.toString()}`;
}

export function isAffiliateUrl(url: string | undefined): boolean {
  return Boolean(url && url.startsWith('https://tp.media/r?'));
}

/** Builds the outbound booking URL for one option. Never throws and never returns empty. */
export function buildBookingUrl(
  option: Pick<TransitOption, 'mode'>,
  ctx: BookingContext
): string {
  if (option.mode === 'flight') {
    const search = aviasalesSearchUrl(ctx);
    return search ? wrapAffiliateUrl(search) : googleFlightsUrl(ctx);
  }
  return rome2rioUrl(ctx);
}

/**
 * Returns copies of `options` with `bookingUrl` populated (overwriting stale values so config,
 * date and route changes always take effect). Input options are not mutated.
 */
export function attachBookingUrls(options: TransitOption[], ctx: BookingContext): TransitOption[] {
  return options.map((option) => ({ ...option, bookingUrl: buildBookingUrl(option, ctx) }));
}
