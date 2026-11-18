# Astris Travel

**Plan multi-city trips on a map, compare real fares and book directly with the seller.**

Live: **[astris-travel.vercel.app](https://astris-travel.vercel.app)**

Astris Travel is a multi-destination trip planner. Add your stops, drag them into any order, and every leg between them gets
ranked flight options, ground timetables and places to stay. Instead of sorting by price alone, options are ranked by a
**Smart Score** that also weighs travel time, layovers, red-eyes, connections and airport changes against how much your time
is worth to you.

No account is needed to use any of it.

---

## Features

- **Multi-city itineraries:** add, remove and drag-reorder stops; dates recalculate automatically. One-way or return per
  leg, with an automatic cheapest-structure comparison.
- **Interactive world map:** great-circle flight arcs between exact airport coordinates, dashed airport-transfer
  connectors, and land-following lines for trains and buses (MapLibre GL).
- **Smart Score ranking:** a Value-of-Travel-Time-Savings model. A pacing slider (backpacker → express) sets what an hour
  of your time is worth, and every option is re-scored instantly.
- **Real fares only:**
  - Recent fares from the Aviasales Data API.
  - Live Google Flights fares (via SerpApi) on request, with the exact sellers of a ticket (the airline and agencies,
    each with its own price and baggage fees).
  - No invented prices or schedules: a leg with no real fare says so.
- **Direct booking handoff:** "Proceed to {Seller}" opens that seller's checkout for the exact ticket. Trains, buses and
  ferries link to 12Go / FlixBus; stays to Booking.com, Agoda and Trip.com.
- **Ground schedules & stays:** public-transport directions (Google Routes), 12Go timetables, and live hotels with
  sorting and filters for every stop.
- **Boarding-pass style tickets:** airline-branded flight cards plus bus and train tickets, with tags such as *Direct*,
  *Cheapest* and *Cheapest Direct*.
- **Currency switcher:** USD, MYR, EUR, GBP, TRY, JPY, SGD, using ECB reference rates.
- **Guest-first, sync optional:**
  - Your route is saved in the browser automatically.
  - *Copy route sync link* opens it on any device.
  - Signing in (Google or email) syncs routes to your account.

## Tech stack

| Layer | Tools |
| :--- | :--- |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 4, MapLibre GL / react-map-gl, dnd-kit, Turf, Motion |
| Backend | Node.js + Express (one app: local server and a single Vercel serverless function) |
| Data | SerpApi (Google Flights & Hotels), Aviasales Data API, Google Routes API, 12Go, Frankfurter (ECB rates), `airports` dataset |
| Accounts | Supabase Auth (Google OAuth, email magic link / code) + Postgres with Row-Level Security |
| Caching & limits | Upstash Redis (response cache and sliding-window rate limits), in-memory fallback |
| Validation & tests | zod, Node test runner via `tsx --test` |
| Hosting | Vercel |

## Getting started

**Prerequisites:** Node.js 20+ and npm.

```bash
git clone https://github.com/mdrakibulhasan615/Astris_Travel.git
cd Astris_Travel
npm install
cp .env.example .env.local   # optional: every key is optional
npm run dev
```

Open <http://localhost:3000>. Without any keys the app still runs: you can build routes and use the map, and fares appear
once a data source is configured.

### Environment variables

All variables are read **server-side only** and live in `.env.local` (locally) or your host's environment settings.
`.env.example` documents each one.

| Variable | Enables |
| :--- | :--- |
| `SERPAPI_API_KEY` | Live flight fares, exact-ticket sellers and live hotels |
| `USE_REAL_DATA` | `true` lets the *Fetch Live Fares* button spend SerpApi searches |
| `TRAVELPAYOUTS_TOKEN` | Recent real fares from the Aviasales Data API |
| `GOOGLE_MAPS_API_KEY` | Public-transport directions (Google Routes API) |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Shared cache and rate limits across instances |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | Accounts and cross-device route sync |
| `APP_URL`, `ALLOWED_ORIGINS` | Public site URL for login redirects; allowed CORS origins |
| `TRIPCOM_*`, `BOOKING_AID`, `AGODA_CID`, `TWELVEGO_AFFILIATE_ID` | Partner attribution on booking links |

### Accounts (optional)

1. Create a Supabase project and run [`supabase/migrations/001_saved_routes.sql`](supabase/migrations/001_saved_routes.sql)
   in the SQL editor.
2. Enable the **Google** and **Email** providers in Supabase Auth.
3. In Supabase → Authentication → URL Configuration, set the Site URL to your `APP_URL` and add
   `<APP_URL>/api/auth/callback` to the Redirect URLs.
4. In your Google OAuth client, add `https://<project-ref>.supabase.co/auth/v1/callback` as an authorized redirect URI.

Without Supabase the app runs in guest mode: routes persist in the browser and the share link still works.

## Scripts

| Command | Description |
| :--- | :--- |
| `npm run dev` | Express + Vite dev server on port 3000 |
| `npm run build` | Production client build to `dist/` |
| `npm run lint` | Type-check client, server and shared code |
| `npm test` | Unit and integration tests |
| `npm run headers:sync` | Copy the security headers into `vercel.json` |

## Project structure

```text
├── server.ts            Express app: API routes, dev/production serving
├── server/              Fare providers, caching, auth, security (rate limits, validation, headers)
├── shared/              Code used by both server and browser: Smart Score, booking links, fares, routing
├── src/                 React app: App.tsx (state), components/, context/ (auth, login prompts)
├── api/index.ts         Vercel serverless entry
├── supabase/migrations/ Database schema with Row-Level Security
└── ARCHITECTURE.md      Full system design: scoring model, data pipeline, API reference
```

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the scoring formulas, data pipeline, API routes and conventions.

## Security

- API keys never reach the browser.
- Login sessions are kept in `HttpOnly` cookies.
- Saved routes are protected by Postgres Row-Level Security.
- Endpoints that spend provider quota are rate-limited per IP and per session.
- Every request body is validated.
- Seller links are restricted to `https`.
- Production responses carry a strict Content-Security-Policy, HSTS and anti-clickjacking headers.
- Cross-site requests that change data are rejected.

## Deployment

The project deploys to Vercel as-is:
- `vercel.json` builds the Vite client to `dist/`.
- It routes `/api/*` to the Express app in `api/index.ts`.
- It applies the security headers.

Set the environment variables in the Vercel dashboard and redeploy.
