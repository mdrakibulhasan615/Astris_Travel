import type { TransitOption } from './types.ts';

/**
 * Affiliate booking deep links (ARCHITECTURE.md §3 / §6).
 *
 * Flights  → Aviasales search deep link `https://www.aviasales.com/search/{route}`, attributed to our
 *            Travelpayouts partner account via `?marker=`. Optional redirect mode wraps the same
 *            link in `tp.media/r` (see `linkMode`).
 * Ground   → Rome2Rio route page (no affiliate program wired up yet).
 * Fallback → Google Flights search when the route or date can't form a valid Aviasales path.
 *
 * Aviasales path grammar (one-way / round trip):
 *   {ORIGIN}{DDMM}{DEST}{PAX}              e.g. KUL2111IST1     (21 Nov, 1 adult)
 *   {ORIGIN}{DDMM}{DEST}{DDMM}{PAX}        e.g. KUL2111IST25111 (out 21 Nov, back 25 Nov)
 * where DDMM is zero-padded day + month and PAX is the adult count.
 *
 * Pure and dependency-free so it runs on both server (credentials configured) and client
 * (unconfigured → plain, un-attributed links that the server later replaces).
 */

export interface AffiliateConfig {
  /** Travelpayouts partner marker (numeric id in practice, e.g. `123456`). */
  marker?: string;
  /** Optional sub-id for traffic-source reporting, appended as `marker.subid` (or `trs` in redirect mode). */
  trs?: string;
  /** Travelpayouts campaign id for Aviasales (redirect mode). */
  campaignId?: string;
  /** Travelpayouts program id (`p`) for Aviasales (redirect mode). */
  programId?: string;
  /**
   * `direct` (default): `https://www.aviasales.com/search/...?marker=...`
   * `redirect`: `https://tp.media/r?marker=...&campaign_id=...&u=<aviasales url>`
   */
  linkMode?: 'direct' | 'redirect';
  /** Log every distinct generated URL (development only; set by the server). */
  debug?: boolean;
}

export interface BookingContext {
  fromCode: string;
  toCode: string;
  fromCity?: string;
  toCity?: string;
  /** Departure date, `YYYY-MM-DD` (a trailing time component is tolerated). */
  date?: string;
  /** Optional return date, same format; ignored when before `date`. */
  returnDate?: string;
  /** Adult passengers (1–9). */
  passengers?: number;
}

// Aviasales (campaign 100 / program 4114) — verify against your Travelpayouts dashboard.
const DEFAULT_CAMPAIGN_ID = '100';
const DEFAULT_PROGRAM_ID = '4114';

const MARKER_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const SUBID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const NUMERIC_ID_RE = /^\d{1,9}$/;
const IATA_RE = /^[A-Za-z]{3}$/;

let activeConfig: AffiliateConfig = {};
const loggedUrls = new Set<string>();

function warn(message: string): void {
  console.warn(`[Affiliate] ${message}`);
}

/** Cleans one config value; invalid values are dropped with a warning naming the env key. */
function validated(value: string | undefined, re: RegExp, envName: string): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (!re.test(v)) {
    warn(`${envName} has an invalid format and was ignored (allowed pattern: ${re.source}).`);
    return undefined;
  }
  return v;
}

/** Called once on the server at startup with values read from the environment. */
export function configureAffiliate(config: AffiliateConfig): void {
  activeConfig = {
    marker: validated(config.marker, MARKER_RE, 'TRAVELPAYOUTS_MARKER'),
    trs: validated(config.trs, SUBID_RE, 'TRAVELPAYOUTS_TRS'),
    campaignId: validated(config.campaignId, NUMERIC_ID_RE, 'TRAVELPAYOUTS_CAMPAIGN_ID'),
    programId: validated(config.programId, NUMERIC_ID_RE, 'TRAVELPAYOUTS_PROGRAM_ID'),
    linkMode: config.linkMode === 'redirect' ? 'redirect' : 'direct',
    debug: Boolean(config.debug),
  };
  loggedUrls.clear();
  if (activeConfig.debug) {
    const c = activeConfig;
    console.log(
      `[Affiliate] mode=${c.linkMode} marker=${c.marker ? 'set' : 'MISSING'} ` +
        `subid=${c.trs ? 'set' : 'none'} campaign=${c.campaignId ?? DEFAULT_CAMPAIGN_ID} ` +
        `program=${c.programId ?? DEFAULT_PROGRAM_ID}`
    );
  }
}

export function isAffiliateConfigured(): boolean {
  return Boolean(activeConfig.marker);
}

/** Parses `YYYY-MM-DD[...]` into validated parts; rejects impossible dates like 2026-02-31. */
function parseIsoDate(value: string | undefined): { y: number; m: number; d: number } | null {
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

/** Strict DDMM: two-digit day then two-digit month, zero padded (5 March → "0503"). */
export function formatDDMM(date: { m: number; d: number }): string {
  return `${String(date.d).padStart(2, '0')}${String(date.m).padStart(2, '0')}`;
}

function toUtcDay(date: { y: number; m: number; d: number }): number {
  return Date.UTC(date.y, date.m - 1, date.d);
}

/**
 * Builds the Aviasales route segment, e.g. `KUL2111IST1` or `KUL2111IST25111`.
 * Returns null when the airport codes or departure date are unusable.
 */
export function buildAviasalesRoute(ctx: BookingContext): string | null {
  const dep = parseIsoDate(ctx.date);
  if (!dep || !IATA_RE.test(ctx.fromCode?.trim()) || !IATA_RE.test(ctx.toCode?.trim())) return null;

  const ret = parseIsoDate(ctx.returnDate);
  // A return date before departure would produce a nonsense search; treat it as one-way.
  const returnPart = ret && toUtcDay(ret) >= toUtcDay(dep) ? formatDDMM(ret) : '';

  const adults = Math.min(9, Math.max(1, Math.floor(Number(ctx.passengers ?? 1)) || 1));
  return (
    `${ctx.fromCode.trim().toUpperCase()}${formatDDMM(dep)}` +
    `${ctx.toCode.trim().toUpperCase()}${returnPart}${adults}`
  );
}

function aviasalesSearchUrl(ctx: BookingContext, marker?: string): string | null {
  const route = buildAviasalesRoute(ctx);
  if (!route) return null;
  const base = `https://www.aviasales.com/search/${route}`;
  return marker ? `${base}?marker=${encodeURIComponent(marker)}` : base;
}

function googleFlightsUrl(ctx: BookingContext): string {
  const dep = parseIsoDate(ctx.date);
  const date = dep
    ? ` on ${dep.y}-${String(dep.m).padStart(2, '0')}-${String(dep.d).padStart(2, '0')}`
    : '';
  const q = `Flights from ${ctx.fromCity || ctx.fromCode} to ${ctx.toCity || ctx.toCode}${date}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

function rome2rioUrl(ctx: BookingContext): string {
  const slug = (s: string) => encodeURIComponent(s.trim().replace(/\s+/g, '-'));
  return `https://www.rome2rio.com/map/${slug(ctx.fromCity || ctx.fromCode)}/${slug(ctx.toCity || ctx.toCode)}`;
}

/** `marker` or `marker.subid` — Travelpayouts' convention for per-source reporting. */
function markerWithSubId(config: AffiliateConfig): string | undefined {
  if (!config.marker) return undefined;
  return config.trs ? `${config.marker}.${config.trs}` : config.marker;
}

/**
 * Wraps a destination URL in a Travelpayouts tracking redirect (redirect mode). With no marker the
 * URL is returned unchanged.
 */
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

/** True when the link carries our partner marker (direct or redirect form). */
export function isAffiliateUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.hostname === 'tp.media') return u.pathname === '/r' && u.searchParams.has('marker');
    return u.hostname.endsWith('aviasales.com') && u.searchParams.has('marker');
  } catch {
    return false;
  }
}

function debugLog(url: string, ctx: BookingContext, kind: string): void {
  if (!activeConfig.debug || loggedUrls.has(url)) return;
  if (loggedUrls.size > 500) loggedUrls.clear();
  loggedUrls.add(url);
  console.log(
    `[Affiliate] ${kind} ${ctx.fromCode}→${ctx.toCode} date=${ctx.date ?? '-'}` +
      `${ctx.returnDate ? ` return=${ctx.returnDate}` : ''} adults=${ctx.passengers ?? 1}\n    ${url}`
  );
}

/** Builds the outbound booking URL for one option. Never throws and never returns empty. */
export function buildBookingUrl(option: Pick<TransitOption, 'mode'>, ctx: BookingContext): string {
  let url: string;
  let kind: string;
  if (option.mode === 'flight') {
    if (activeConfig.linkMode === 'redirect') {
      const search = aviasalesSearchUrl(ctx);
      url = search ? wrapAffiliateUrl(search) : googleFlightsUrl(ctx);
    } else {
      url = aviasalesSearchUrl(ctx, markerWithSubId(activeConfig)) ?? googleFlightsUrl(ctx);
    }
    kind = url.startsWith('https://www.google.com') ? 'flight(fallback: invalid route/date)' : 'flight';
  } else {
    url = rome2rioUrl(ctx);
    kind = option.mode;
  }
  debugLog(url, ctx, kind);
  return url;
}

/**
 * Returns copies of `options` with `bookingUrl` populated (overwriting stale values so config,
 * date and route changes always take effect). Input options are not mutated.
 */
export function attachBookingUrls(options: TransitOption[], ctx: BookingContext): TransitOption[] {
  return options.map((option) => ({ ...option, bookingUrl: buildBookingUrl(option, ctx) }));
}
