/**
 * Ticket data source. ONE flag to flip between the built-in sample data and live SerpApi fares.
 *
 *   false (default)  sample/curated tickets only. No SerpApi request is made (not on page load, not
 *                    on reload, not on any edit) and the Redis fare cache is not touched, so
 *                    developing the UI never spends SerpApi credits.
 *   true             live Google Flights fares via SerpApi (needs SERPAPI_KEY), cached in Redis for
 *                    12 hours. Ground transport stays curated/estimated either way: there is no live
 *                    availability API for trains and coaches.
 *
 * Change it here, or override per environment without touching code: set `USE_REAL_DATA=true` (or
 * `false`) in `.env.local` locally, or in the Vercel project's environment variables. The
 * environment variable wins when it is set; see `useRealData()` in `server/env.ts`.
 *
 * Vercel note: deployments are NOT live by default. Set `USE_REAL_DATA=true` for the environment
 * (Production, and Preview if you want it) that should spend credits.
 */
export const USE_REAL_TICKET_DATA = false;

/**
 * Public partner ids used when the matching environment variable is not set. They are not secrets
 * (every outbound link carries them), and defaulting them means a fresh deployment earns
 * commission without extra setup. An environment variable always wins.
 *   twelveGoAffiliateId     12Go `z` parameter (TWELVEGO_AFFILIATE_ID)
 *   travelpayoutsMarker     Aviasales partner marker on fare links (TRAVELPAYOUTS_MARKER)
 */
export const AFFILIATE_DEFAULTS = {
  twelveGoAffiliateId: '17520220',
  travelpayoutsMarker: '806003',
} as const;
