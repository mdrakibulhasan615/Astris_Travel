import { z } from 'zod';
import type { Trip } from './types.ts';

/**
 * Saved routes: the part of a trip worth keeping (stops, dates, party size, ticket choices) without
 * fares, which expire and are re-fetched. Used by the guest store (`localStorage`), the account sync
 * (`/api/routes`, Supabase `saved_routes`) and the compressed share link (`#r=…`). Every source is
 * untrusted (a link anyone can craft, storage another script could write), so all of them go through
 * `savedRouteDataSchema` before the app uses them.
 */

export const GUEST_ROUTES_KEY = 'astris_guest_routes';
export const MAX_SAVED_ROUTES = 20;
export const ROUTE_LINK_PARAM = 'r';

/** A real calendar date (`2026-02-31` fails), bounded to a sane range. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (y < 2000 || y > 2100) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const isoDate = z.string().max(10).refine(isIsoDate, 'must be a valid YYYY-MM-DD date');
// Markup characters and control codes are removed from free text
// eslint-disable-next-line no-control-regex
const safeText = (max: number) => z.string().max(max).transform((s) => s.replace(/[<>\u0000-\u001F]/g, '').trim());

export const savedStopSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[\w.:-]+$/),
  city: safeText(120),
  country: safeText(120),
  iataCode: z.string().max(4).regex(/^[A-Za-z0-9]{0,4}$/),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  stayNights: z.number().int().min(0).max(365),
  arrivalDate: isoDate,
  departureDate: isoDate,
});

export const legPrefSchema = z.object({
  type: z.enum(['one-way', 'return']),
  returnDate: isoDate.optional(),
});

/** The route payload: ~1–3 KB of JSON for a typical trip. */
export const savedRouteDataSchema = z.object({
  v: z.literal(1),
  title: safeText(120),
  travelers: z.number().int().min(1).max(9),
  stops: z.array(savedStopSchema).min(1).max(30),
  legPrefs: z.record(z.string().max(160), legPrefSchema).optional(),
});

export const clientIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'must be a route id');

export const savedRouteSchema = z.object({
  clientId: clientIdSchema,
  updatedAt: z.string().datetime({ offset: true }),
  data: savedRouteDataSchema,
});

export const routeImportSchema = z.object({ routes: z.array(savedRouteSchema).max(MAX_SAVED_ROUTES) });

export type SavedRouteData = z.infer<typeof savedRouteDataSchema>;
export type SavedRoute = z.infer<typeof savedRouteSchema>;

/** A random, URL-safe route id. */
export function newRouteId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The storable part of a trip, or `null` for a trip with no stops. */
export function routeDataFromTrip(trip: Pick<Trip, 'title' | 'travelers' | 'stops' | 'legPrefs'>): SavedRouteData | null {
  const parsed = savedRouteDataSchema.safeParse({
    v: 1,
    title: trip.title || 'My trip',
    travelers: trip.travelers,
    stops: trip.stops.map(({ id, city, country, iataCode, lat, lng, stayNights, arrivalDate, departureDate }) => ({
      id,
      city,
      country,
      iataCode,
      lat,
      lng,
      stayNights,
      arrivalDate,
      departureDate,
    })),
    ...(trip.legPrefs && Object.keys(trip.legPrefs).length ? { legPrefs: trip.legPrefs } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/** Stable text for "did the route change?" checks (stop order, dates, party, ticket choices). */
export function routeSignature(data: SavedRouteData): string {
  return JSON.stringify([
    data.travelers,
    data.stops.map((s) => [s.iataCode, s.city, s.arrivalDate, s.departureDate, s.stayNights]),
    data.legPrefs ?? {},
  ]);
}

/** Parses an untrusted list (storage, an API answer); invalid entries are dropped, not fatal. */
export function parseSavedRoutes(raw: unknown): SavedRoute[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedRoute[] = [];
  for (const item of raw) {
    const r = savedRouteSchema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}

/**
 * Merges two route lists by `clientId`: the newer `updatedAt` wins, routes that only exist on one
 * side are kept, newest first, capped at {@link MAX_SAVED_ROUTES}. Used when a guest logs in.
 */
export function mergeRoutes(a: SavedRoute[], b: SavedRoute[]): SavedRoute[] {
  const byId = new Map<string, SavedRoute>();
  for (const r of [...a, ...b]) {
    const prev = byId.get(r.clientId);
    if (!prev || Date.parse(r.updatedAt) > Date.parse(prev.updatedAt)) byId.set(r.clientId, r);
  }
  return [...byId.values()]
    .sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt))
    .slice(0, MAX_SAVED_ROUTES);
}

// ── Compressed share link ────────────────────────────────────────────────────────────────────────
// `z` + base64url(deflate-raw(JSON)) where CompressionStream exists, else `j` + base64url(JSON).

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: GenerateTransformStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
type GenerateTransformStream = TransformStream<Uint8Array, Uint8Array>;

const MAX_LINK_CHARS = 16_000;
const MAX_INFLATED_BYTES = 64_000;

export async function encodeRouteLink(data: SavedRouteData): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(data));
  if (typeof CompressionStream === 'function') {
    return `z${toBase64Url(await pipe(json, new CompressionStream('deflate-raw') as GenerateTransformStream))}`;
  }
  return `j${toBase64Url(json)}`;
}

/** The route in a share-link token, or `null` when it is missing, corrupt, oversized or invalid. */
export async function decodeRouteLink(token: string): Promise<SavedRouteData | null> {
  if (!token || token.length > MAX_LINK_CHARS || !/^[zj][A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    let bytes = fromBase64Url(token.slice(1));
    if (token[0] === 'z') {
      if (typeof DecompressionStream !== 'function') return null;
      bytes = await pipe(bytes, new DecompressionStream('deflate-raw') as GenerateTransformStream);
    }
    if (bytes.length > MAX_INFLATED_BYTES) return null;
    const r = savedRouteDataSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
