/**
 * Environment bootstrap. MUST be the first import of every server entry point:
 *
 *   import './server/env.ts';   // <- before any service or API client is imported
 *
 * ES module imports are hoisted and evaluated in order, so a `dotenv.config()` call placed in the
 * body of server.ts runs AFTER all of its imports have already read `process.env`. Importing this
 * module first guarantees the files are loaded before anything else initialises.
 *
 * Load order (dotenv never overrides a variable that is already set, so first wins):
 *   1. real environment (CI / hosting provider)   2. .env.local   3. .env
 * Paths are resolved from the project root, not the current working directory, so
 * `tsx /abs/path/server.ts` from another folder still finds the files.
 */
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USE_REAL_TICKET_DATA } from '../shared/config.ts';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILES = ['.env.local', '.env'];

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const loadedFiles: string[] = [];
const missingFiles: string[] = [];
for (const name of ENV_FILES) {
  const file = path.join(PROJECT_ROOT, name);
  if (!fs.existsSync(file)) {
    missingFiles.push(name);
    continue;
  }
  const result = dotenv.config({ path: file, quiet: true });
  if (result.error) {
    console.warn(`[env] Could not parse ${name}: ${result.error.message}`);
  } else {
    loadedFiles.push(name);
  }
}

// SERPAPI_KEY was this project's first name for the key; SERPAPI_API_KEY is the current one
if (!process.env.SERPAPI_API_KEY && process.env.SERPAPI_KEY) process.env.SERPAPI_API_KEY = process.env.SERPAPI_KEY;

/**
 * Whether the "Fetch Live Fares" button may spend SerpApi searches (true), or the app stays on the
 * built-in sample data (false). The default is
 * `USE_REAL_TICKET_DATA` in `shared/config.ts`; the `USE_REAL_DATA` environment variable overrides it
 * (`true`/`1`/`yes`/`on`, or `false`/`0`/`no`/`off`). Live fares are never fetched automatically.
 */
export function useRealData(): boolean {
  const raw = getEnv('USE_REAL_DATA')?.toLowerCase();
  if (raw) {
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    console.warn(`[env] USE_REAL_DATA="${raw}" is not a boolean; using the default from shared/config.ts.`);
  }
  return USE_REAL_TICKET_DATA;
}

/** Values copied straight from `.env.example` look set but are not real credentials. */
const PLACEHOLDER_RE = /^(your[-_ ]|my[-_]|changeme|replace[-_ ]?me|todo$|x{3,}$|<.+>$)/i;

/**
 * Reads a variable: trimmed, surrounding quotes stripped, and placeholder / empty values treated
 * as missing (returns `undefined`). Read lazily at call time rather than at module load.
 */
export function getEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  if (!value || PLACEHOLDER_RE.test(value)) return undefined;
  return value;
}

export interface EnvKeySpec {
  name: string;
  /** What stops working (or degrades) without the key. */
  purpose: string;
  /** Names that must ALL be set for the feature to work are listed as separate specs. */
  fallback: string;
}

/**
 * Keys reported at startup. (GEMINI_API_KEY is not used yet. The optional
 * `*_TRACKING_TEMPLATE` keys and TWELVEGO_AFFILIATE_ID are read too but not reported as missing.)
 */
export const ENV_KEYS: EnvKeySpec[] = [
  { name: 'SERPAPI_API_KEY', purpose: 'live fares and exact-ticket sellers (SerpApi Google Flights) and live hotels', fallback: 'estimated schedules and exact-route search links' },
  { name: 'GOOGLE_MAPS_API_KEY', purpose: 'real transit directions and map lines (Google Routes API)', fallback: 'no transit directions (12Go timetables still work)' },
  { name: 'TRAVELPAYOUTS_TOKEN', purpose: 'recent real fares in sample mode (Aviasales Data API)', fallback: 'fully sample flights' },
  { name: 'UPSTASH_REDIS_REST_URL', purpose: '12-hour transit cache (Upstash Redis)', fallback: 'uncached queries' },
  { name: 'UPSTASH_REDIS_REST_TOKEN', purpose: '12-hour transit cache (Upstash Redis)', fallback: 'uncached queries' },
  { name: 'BOOKING_AID', purpose: 'Booking.com attribution on stay links', fallback: 'un-attributed Booking.com links (no commission)' },
  { name: 'AGODA_CID', purpose: 'Agoda attribution on stay links', fallback: 'un-attributed Agoda links (no commission)' },
];

const warned = new Set<string>();

/** Logs a missing-key warning once per key. Never throws. */
export function warnMissingKey(name: string, context?: string): void {
  if (warned.has(name)) return;
  warned.add(name);
  const spec = ENV_KEYS.find((k) => k.name === name);
  const detail = spec ? ` ${spec.purpose} disabled; using ${spec.fallback}.` : '';
  console.warn(
    `[env] ${name} is not set (or still a placeholder).${detail}` +
      `${context ? ` (${context})` : ''} Add ${name}="..." to .env.local in the project root.`
  );
}

/** Call once at startup: reports which env files loaded and which expected keys are absent. */
export function logEnvStatus(): void {
  if (useRealData()) {
    console.log(
      getEnv('SERPAPI_API_KEY')
        ? '[data] live fares: ON (SerpApi), on request only. Each uncached search and each "Book Exact Ticket" lookup spends one of the monthly searches.'
        : '[data] live fares: requested, but SERPAPI_API_KEY is missing: estimated schedules and route links are shown.'
    );
  } else {
    console.log(
      '[data] live fares: OFF. No SerpApi requests are made. ' +
        'Set USE_REAL_DATA=true (or USE_REAL_TICKET_DATA in shared/config.ts) to enable "Fetch Live Fares".' +
        (getEnv('TRAVELPAYOUTS_TOKEN')
          ? ' Flights use recent real fares from the Aviasales Data API where it has them.'
          : '')
    );
  }
  const loaded = loadedFiles.length ? loadedFiles.join(', ') : 'none';
  const missing = ENV_KEYS.filter((k) => !getEnv(k.name));

  if (IS_PRODUCTION) {
    // Production: one concise line, no per-key noise.
    console.log(
      `[env] files loaded: ${loaded}; missing optional keys: ${missing.map((k) => k.name).join(', ') || 'none'}`
    );
    return;
  }

  console.log(`[env] project root: ${PROJECT_ROOT}`);
  console.log(`[env] files loaded: ${loaded}${missingFiles.length ? ` (not found: ${missingFiles.join(', ')})` : ''}`);
  for (const key of ENV_KEYS) {
    if (getEnv(key.name)) {
      console.log(`[env] ✓ ${key.name} set`);
    } else {
      warnMissingKey(key.name);
    }
  }
}
