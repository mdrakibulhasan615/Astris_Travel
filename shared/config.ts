/**
 * Ticket data source. ONE flag to flip between the built-in sample data and live Duffel fares.
 *
 *   false            sample/curated tickets only (plus recent real fares from the free Aviasales Data
 *                    API when TRAVELPAYOUTS_TOKEN is set). No Duffel request is made, so developing
 *                    the UI never searches or books anything.
 *   true (default)   live, bookable Duffel offers (needs DUFFEL_ACCESS_TOKEN) with a service fee
 *                    added, cached 10 minutes, checked out through Duffel Links. Airlines Duffel does
 *                    not sell (AirAsia, Ryanair…) appear as "Book direct" partner links. Ground
 *                    transport stays curated/estimated either way: there is no live availability API
 *                    for trains and coaches.
 *
 * Change it here, or override per environment without touching code: set `USE_REAL_DATA=true` (or
 * `false`) in `.env.local` locally, or in the Vercel project's environment variables. The
 * environment variable wins when it is set; see `useRealData()` in `server/env.ts`.
 *
 * Vercel note: deployments are NOT live by default. Set `USE_REAL_DATA=true` for the environment
 * (Production, and Preview if you want it) that should search Duffel.
 */
export const USE_REAL_TICKET_DATA = true;

/**
 * Whether the animated landing hero covers the planner on load. Off for now: the app opens straight
 * on the map and itinerary. Flip to `true` to bring the hero back.
 */
export const SHOW_HOME_HERO = false;

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
