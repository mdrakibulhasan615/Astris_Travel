/**
 * Live fares switch. ONE flag to allow or forbid the "Fetch Live Fares" button spending SerpApi searches.
 *
 *   false            no SerpApi request is ever made: the button answers with exact-route search links
 *                    only. A corridor still shows recent real fares from the free Aviasales Data API
 *                    when TRAVELPAYOUTS_TOKEN is set.
 *   true (default)   the button fetches live Google Flights fares (needs SERPAPI_API_KEY) and "Book
 *                    Exact Ticket" looks up the sellers of one fare. Both are on request only: nothing is
 *                    fetched on page load or on an edit, because the free plan has 100 searches a
 *                    month. Results are cached 30 minutes (fares) and 15 minutes (sellers).
 *
 * There is no made-up data behind either setting: a corridor with no real fare simply shows none.
 * Trains and coaches have no live availability API, so they appear only through the real timetables
 * of the Schedules panel (12Go, Google transit).
 *
 * Change it here, or override per environment without touching code: set `USE_REAL_DATA=true` (or
 * `false`) in `.env.local` locally, or in the Vercel project's environment variables. The
 * environment variable wins when it is set; see `useRealData()` in `server/env.ts`.
 *
 * Vercel note: deployments are NOT live by default. Set `USE_REAL_DATA=true` for the environment
 * (Production, and Preview if you want it) that should offer live fares.
 */
export const USE_REAL_TICKET_DATA = true;

/**
 * Whether the home page (a single destination bar that flies onto the planner once you start typing)
 * covers the planner on load. `false` opens straight on the map and itinerary.
 */
export const SHOW_HOME_HERO = true;

/**
 * Public partner ids used when the matching environment variable is not set. They are not secrets
 * (every outbound link carries them), and defaulting them means a fresh deployment earns
 * commission without extra setup. An environment variable always wins.
 *   twelveGoAffiliateId     12Go `z` parameter (TWELVEGO_AFFILIATE_ID)
 *   travelpayoutsMarker     Aviasales partner marker on fare links (TRAVELPAYOUTS_MARKER)
 *   tripcomAllianceId/Sid/Sub3  Trip.com partner ids on flight, train and hotel links
 *                           (TRIPCOM_ALLIANCE_ID, TRIPCOM_SID, TRIPCOM_SUB3; the VITE_TRIP_ALLIANCE_ID and
 *                           VITE_TRIP_SID names work too)
 */
export const AFFILIATE_DEFAULTS = {
  twelveGoAffiliateId: '17520220',
  travelpayoutsMarker: '806003',
  tripcomAllianceId: '11395112',
  tripcomSid: '336262403',
  tripcomSub3: 'D21235867',
} as const;
