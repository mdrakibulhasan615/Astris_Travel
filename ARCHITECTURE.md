# Astris Travel — System & Architecture Reference

> Source of truth for system design, the Smart Score (VTTS) engine, and the affiliate booking flow.
> Last synced with the codebase: 2026-11-14. If you change a path, env var, endpoint, or scoring
> constant, update this file in the same commit.

## 1. Project Overview & Core Philosophy
**Astris Travel** is a multi-destination travel planning and booking app. Instead of dumping raw
listings, it ranks multi-modal routes (flight / train / bus / ferry) with a **Smart Score** built on
**VTTS (Value of Travel Time Savings)** tuned to the traveler's pacing and preferences, applies promo
vouchers before ranking, and maps airport-to-airport paths. Outbound booking links are affiliate
deep links.

---

## 2. Tech Stack & Infrastructure
- **Frontend:** React 19, TypeScript, Vite 8, Tailwind CSS 4, MapLibre GL / `react-map-gl`,
  `@dnd-kit` (drag-and-drop stops), `@turf/great-circle` (flight arcs), `lucide-react`, `motion`.
- **Backend (primary):** Node.js + Express 4 in a single entry, `server.ts`, run with `tsx`.
  In development it mounts Vite as middleware; in production it serves `dist/`.
- **Caching:** Upstash Redis (`@upstash/redis`, HTTP/REST) — **12-hour (`43200s`) TTL** on transit
  search responses, with an in-process L1 cache of the same TTL in front of it. **Only live (SerpApi)
  results are cached**; curated/synthesized fallbacks are rebuilt each time so sample data can never be
  served as a cache hit or shadow real fares. Redis is optional.
- **Shared code:** `shared/` is imported by both server and client (pure TypeScript, no Node APIs).
- **Prototype persistence (not wired to the app):** `backend/` is a FastAPI + PostgreSQL schema
  prototype. It serves mock data and the route optimizer only. **It contains no scoring logic** —
  `shared/smartScore.ts` is the only Smart Score implementation.

### Scripts
| Script | Command | Purpose |
| :--- | :--- | :--- |
| `npm run dev` | `tsx server.ts` | Express + Vite middleware on `PORT` (default 3000) |
| `npm run build` | `vite build` | Client bundle to `dist/` |
| `npm run lint` | `tsc --noEmit` | Type-check client, server and shared code |

### Environment variables (`.env.local`, see `.env.example`)
Loading is centralised in `server/env.ts`, which must be the **first import** of `server.ts` (ES imports
are hoisted, so a `dotenv.config()` call in the file body would run after services already read
`process.env`). Order: real environment → `.env.local` → `.env`, resolved from the project root (not the
cwd). `getEnv()` trims, strips quotes and treats `.env.example` placeholders (`your-…`, `MY_…`) as
missing; missing keys log a one-time `[env] NAME is not set…` warning at startup and on first use, never
a crash. **Client:** the browser uses no environment variables (booking links and scores come from the
server). If one is ever needed, it must be named `VITE_*` and read via `import.meta.env.VITE_*`;
unprefixed keys (including `GEMINI_API_KEY`) are deliberately never exposed to the bundle.

| Variable | Required | Used by | Purpose |
| :--- | :--- | :--- | :--- |
| `PORT` | no (3000) | `server.ts` | HTTP port |
| `SERPAPI_KEY` | no | `server/transitService.ts` | Live Google Flights search (`engine=google_flights`). Absent → curated/synthesized corridors |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | no | `server/transitService.ts` | 12-hour transit cache |
| `TRAVELPAYOUTS_MARKER` | no | `shared/affiliate.ts` (configured in `transitService.ts`) | Partner marker, injected as `?marker=`. Absent → booking links work but are **not attributed** |
| `TRAVELPAYOUTS_TRS` | no | same | Optional sub-id: sent as `marker.subid` (direct mode) or `trs` (redirect mode) |
| `TRAVELPAYOUTS_LINK_MODE` | no (`direct`) | same | `direct` = `aviasales.com/search/...?marker=`; `redirect` = `tp.media/r?...&u=` |
| `TRAVELPAYOUTS_CAMPAIGN_ID`, `TRAVELPAYOUTS_PROGRAM_ID` | no | same | Redirect mode only. Aviasales campaign (default `100`) / program (default `4114`) — verify in your Travelpayouts dashboard |
| `DUFFEL_ACCESS_TOKEN` | **Phase 2 — not read by any code yet** | — | Reserved for native Duffel offers/orders |
| `GEMINI_API_KEY`, `APP_URL` | no | — | AI Studio scaffolding; **not read by any code today** |

---

## 3. External Services & Data Pipelines

| Layer | Provider / Package | Implementation & Role |
| :--- | :--- | :--- |
| **Live Flight Discovery** | **SerpApi** (`engine=google_flights`) | `fetchSerpApiFlights` in `server/transitService.ts`. Parses `best_flights`/`other_flights` into `TransitOption`s (price, segments, layovers, emissions). 8s timeout; any failure falls back silently. |
| **Fallback corridors** | `CURATED_CORRIDOR_OPTIONS` + `synthesizeCorridorOptions` | Hand-authored options for the default trip's corridors; every other pair is synthesized (flight / 1-stop / rail / coach) from great-circle distance. |
| **Global Airport Data** | **`airports`** (npm) | `server/airportService.ts`: autocomplete (`searchAirports`) and IATA → exact tarmac lat/lng (`getAirportByIata`). Registered into `shared/airports.ts` at startup and used for every flight segment (§7). |
| **Vouchers** | `VOUCHERS_CATALOG` (`shared/mockDataset.ts`) + `calculateVoucherDiscount` / `isVoucherCurrentlyValid` (`shared/smartScore.ts`) | Percentage or fixed discounts, `maxDiscountUsd` cap, `minSpendUsd`, mode and carrier restrictions, `validFrom`/`expiresAt`/`isActive`. Validated by `POST /api/vouchers/validate`. There is **no `voucherService.ts`**. |
| **Affiliate Monetization** | **Travelpayouts** (Aviasales) | `shared/affiliate.ts` — see §6. |
| **Ticket Fulfillment** | **Duffel API** *(Phase 2, not implemented)* | Planned: offer requests, single-offer pricing, ancillaries, order creation. `@duffel/api` is not yet a dependency. |

---

## 4. Core File Architecture
```text
├── server.ts                    # Express entry: API routes, input validation, Vite middleware / static serving
├── server/
│   ├── env.ts                   # dotenv bootstrap (.env.local → .env), getEnv(), missing-key warnings — import FIRST
│   ├── transitService.ts        # SerpApi integration, Redis cache wrapper, coordinate resolution, fallback corridors
│   └── airportService.ts        # `airports` dataset search + IATA lookup
├── shared/                      # Imported by server AND client
│   ├── smartScore.ts            # VTTS / Smart Score engine, vouchers math, corridor synthesis, leg building
│   ├── affiliate.ts             # Travelpayouts / Aviasales deep-link builder
│   ├── airports.ts              # Airport anchoring: exact airport coords, city→airport codes, ground connectors
│   ├── types.ts                 # TransitOption, SmartScoreBreakdown, TravelerProfile, Trip, ...
│   ├── mockDataset.ts           # Default trip, destination hubs, vouchers, curated corridors
│   └── dateUtils.ts             # Stop date recalculation after reorder
├── src/
│   ├── main.tsx                 # React root wrapped in <ErrorBoundary>
│   ├── App.tsx                  # State owner: trip, optimistic recompute, API calls, layout
│   └── components/
│       ├── ErrorBoundary.tsx          # Render-error containment (app-level + map-level)
│       ├── TopBar.tsx
│       ├── SortableStopCard.tsx       # Draggable stop in the timeline
│       ├── LegTransitPanel.tsx        # Ranked options per leg: score, flag chips, Book button
│       ├── VttsControlPanel.tsx       # Pacing slider / preset tiers
│       ├── VoucherDrawer.tsx          # Promo entry + savings preview
│       ├── AddStopModal.tsx           # Airport autocomplete (`/api/airports/search`)
│       ├── MultiDestDatePickerModal.tsx
│       ├── RouteOptimizerModal.tsx    # Two-stage optimizer results
│       └── WorldMapCanvas.tsx         # MapLibre map: airport-to-airport flight arcs, dashed airport connectors, airport nodes
└── backend/                     # FastAPI + PostgreSQL schema prototype (no scoring; see §2)
    ├── main.py  models.py  geo.py  database.py  SCHEMA.sql  data/mock_trip.json
```
Path aliases: `@/*` → repo root (`tsconfig.json` `paths` and `vite.config.ts` `resolve.alias`).
Imports use explicit `.ts`/`.tsx` extensions (`allowImportingTsExtensions`).

### HTTP API (`server.ts`)
| Route | Purpose |
| :--- | :--- |
| `GET /api/trips/default` | Default trip; legs go through the same live pipeline as `/api/legs/recompute` (9 s budget, then labelled sample data) |
| `GET /api/destinations`, `GET /api/airports/search?q=&limit=` | Airport hubs / autocomplete |
| `GET /api/vouchers`, `POST /api/vouchers/validate` | Catalog; validate a code against current legs |
| `GET\|POST /api/transit/query` | Single-corridor query through the Redis wrapper (`X-Cache-*` headers) |
| `GET /api/transit/cache/status` | Redis health |
| `POST /api/legs/recompute` | Re-query every leg after stop/VTTS/voucher change (concurrent, with per-leg fallback) |
| `POST /api/optimize-route` | Two-stage route optimizer (distance permutations → Smart Score top 5) |

`hourlyRate`/`hourlyTimeValue`, `travelerProfile`, and `travelers` are sanitized server-side
(`sanitizeHourlyRate`, `sanitizeProfile`); invalid input degrades to defaults rather than NaN.

---

## 5. Smart Score (VTTS) Engine — `shared/smartScore.ts` (canonical)

Lower is better. All time terms are converted to USD with the traveler's hourly rate *r*:

```text
score = priceWeight × netPrice
      + timeWeight  × ( inVehicle + layover + timeOfDay + transfer + airportChange )
```

| Term | Rule |
| :--- | :--- |
| **netPrice** | `basePriceUsd − voucherDiscount` (best active, currently valid voucher; floored at 0) |
| **Pacing → r** | 0 % → $5/hr, 50 % → $15/hr, 100 % → $35/hr (piecewise linear, `pacingPercentToHourlyRate`). Presets: Backpacker $5, Balanced $15, Express $35 |
| **inVehicle** | `inVehicleHours × r × modeMultiplier` (overnight sleeper = 0.4, otherwise 1.0) |
| **layover** | Non-linear, in effective hours × *r* (`layoverEffectiveHours`): **<2 h** 0.25/h; **2–4 h** linear, +1.0/h from a 0.5 h baseline; **>4 h** `2.5 + Δ + 0.5·(e^{0.4Δ} − 1)` where Δ = hours beyond 4 (capped at 12 for the exponent). Continuous at 2 h and 4 h. If a >4 h layover overlaps 23:00–05:00 the option gets the `overnight-layover` flag and +1.5 effective hours. |
| **timeOfDay** | Multiplier on (inVehicle + layover). Departure: 00:00–04:59 ×1.25 (`red-eye`), 05:00–05:59 ×1.15 (`early-departure`), 06:00–06:59 ×1.05, 22:00+ ×1.08. Arrival: 00:00–05:59 ×1.2 (`late-arrival`), 22:00+ ×1.08. Product capped at 1.6. **Disabled** by `profile.allowRedEyes` and for overnight sleepers. |
| **transfer** | `stopsCount` > 0 → `max(0.75 × (n + 0.25·n(n−1)/2) × r, $8 × n)` — escalating 25 % per extra connection; flag `multi-stop` |
| **airportChange** | If consecutive segments' `toCode ≠ next fromCode` (e.g. arrive IST, depart SAW): `max(2.5 × r, $25)`, ×1.5 when the layover is under 4 h; flag `airport-change` |
| **weights** | `TravelerProfile { priceWeight = 1.5, timeWeight = 1.0, allowRedEyes = false }`, each clamped to [0.1, 5]. `profileFromTimeSensitivity(0..1)` maps a slider to weights (0 → 2.25 / 0.5, 0.5 → defaults, 1 → 0.75 / 1.5). |

`computeSmartScore(option, hourlyRate, voucher?, profile?)` returns a `SmartScoreBreakdown`
containing every term, the weights, and `flags` (rendered as chips in `LegTransitPanel`).
Each call is O(1) (~1.5 µs); the slider re-scores all options client-side on every tick.
`recalculateOptionsWithVttsAndVouchers` picks the best voucher per option and sorts ascending.

**Python note:** the former `backend/smart_score.py` (tiered layover multipliers) was removed. Do not
reintroduce scoring in `backend/`; mirror the output types only (`SmartScoreBreakdown` in `models.py`).

---

## 6. Affiliate Booking Flow — `shared/affiliate.ts`

1. Every code path that produces options attaches `bookingUrl` via `attachBookingUrls`:
   `buildLegsFromStops` (default trip, optimizer, client optimistic updates) and
   `queryTransitWithCache` (cache hit, live SerpApi, fallback). Links are rebuilt on each response,
   so a changed marker, date, or route always wins over stale cached values.
2. **Flights** → Aviasales search deep link `https://www.aviasales.com/search/{ORIGIN}{DDMM}{DEST}[{DDMM}]{adults}`
   — e.g. `KUL2111IST1` (21 Nov, 1 adult) or `KUL2111IST25111` (return 25 Nov). DDMM is strictly
   zero-padded day + month from the stop's departure date (`2026-03-05` → `0503`); impossible dates
   (Feb 31) and return-before-departure are rejected. Adults come from `travelers` (clamped 1–9).
   With `TRAVELPAYOUTS_MARKER` set the link gets `?marker=<marker>[.<subid>]`; in `redirect` mode it is
   wrapped as `https://tp.media/r?marker=…&p=…&campaign_id=…[&trs=…]&u=<encoded search url>`.
   Markers/sub-ids/campaign ids are format-validated at startup; invalid values are dropped with a warning.
3. **Invalid route/date** (non-IATA code, malformed date) → Google Flights search URL, never an empty link.
4. **Train / bus / ferry** → Rome2Rio route page (no affiliate program wired yet; un-attributed).
5. The server configures credentials at startup (`configureAffiliate`). The browser has none, so
   optimistic client-side options carry plain links until the server response replaces them
   (typically within one round trip).
6. UI: `LegTransitPanel` shows a **Book** button per option (and for the selected option when the
   leg is collapsed), `target="_blank"`, `rel="sponsored noopener noreferrer"`.
7. In development the server logs each distinct generated URL (`[Affiliate] flight KUL→IST …`) and the
   browser logs the URL on click, so the exact link can be inspected before it opens.
8. SerpApi's `booking_token` is not used: resolving it costs an extra paid request per option, so
   attribution goes through Aviasales instead.

---

## 7. Airport Anchoring & Multi-Modal Separation — `shared/airports.ts`

Invariant: **a flight segment starts and ends on the exact coordinates of an airport**, and any
ground travel to/from the airport is a *separate* connecting segment.
- `resolveAirport(code)` returns tarmac coordinates for an airport code or a metro/city code
  (`LON`→`LHR`, `PAR`→`CDG`, `ROM`→`FCO`, …). Built-in table for the airports the app ships with; the
  server registers the full `airports` dataset via `registerAirportResolver`. City-centre hub
  coordinates (`DESTINATION_HUBS`) are never used for flights.
- `anchorFlightSegments` snaps every flight segment's endpoints and codes to its airports.
  `ensureAirportConnectors` adds an "airport transfer" ground segment (city → airport, airport → city)
  when the first/last segment is a flight whose airport is >3 km from the stop. Existing connectors
  (Havabus, Stansted Express, KLIA Ekspres, metro…) are preserved. `normalizeOptionGeometry` does both
  and is idempotent.
- Applied in `buildLegsFromStops` (curated + synthesized options) and `queryTransitWithCache` (cache
  hit, live SerpApi, fallback). SerpApi hops are resolved from each hop's own `departure_airport.id` /
  `arrival_airport.id`, so SAW vs IST is preserved. Synthesized 1-stop flights connect through a real
  hub airport (`pickConnectionHub`), not a computed midpoint.
- Client fallback: the browser only has the built-in table, so a synthesized flight to an airport outside
  it uses a nearby offset until the server recompute (which has the full dataset) replaces it.

### Map rendering (`WorldMapCanvas.tsx`)
- Flight segments → great-circle arcs between airport nodes only (orange, solid) with labelled IATA
  **airport nodes** at each endpoint.
- Ground segments that lead to/from a flight's airport are **connectors**: straight, dashed, in their own
  GeoJSON source/layer, so they never merge into the flight line. Other ground legs (intercity rail/bus)
  keep their solid polylines and station dots.
- The map re-applies anchoring/connectors defensively before drawing, and a flight with no segment data
  falls back to the leg's airports rather than city centres.

## 8. Flight Data Integrity (backend → UI)

- **One pipeline:** `/api/trips/default` and `/api/legs/recompute` both call `buildLegsViaTransitService`
  (live SerpApi → cache → curated/synthesized fallback). Previously the first page load was pure mock
  data (e.g. "TK 61") and live fares only appeared after the first edit.
- **Provider fields are not invented.** `fetchSerpApiFlights` copies airline(s), every flight number
  (`routeCode` = `"QR 851 + QR 239"`, plus `flightNumbers[]`/`carriers[]`), departure/arrival clock times
  (with `+Nd` computed from the real dates), duration, layovers and price verbatim. An itinerary without
  a price, flights or duration is **dropped**, never given a placeholder fare/time.
- **`dataSource`** (`live` | `curated` | `synthesized`) travels on every `TransitOption`. Cards show
  **Live fare**, **Sample** or **Estimate** chips so illustrative data is never mistaken for a ticket.
  Optimistic client updates (reorder, add stop) are sample data until the server response replaces them;
  the route optimizer ranks with sample corridors, so *Apply* only takes the new stop order and re-queries.
- **UI binding:** `LegTransitPanel` renders `option.carrier`, `routeCode`, `departureTime`/`arrivalTime`,
  `inVehicleHours`, `basePriceUsd`/`discountedPriceUsd` directly from the option (no local arrays);
  cards expose `data-option-id`, `data-route-code`, `data-price`, `data-source` for inspection.
- **Dev logging:** server prints `[Flight Data] <label> <leg> selected=… src=… | carrier flight | dep → arr
  | $price`; the browser logs `[Flights] … → state` tables and, after every state change, checks the ticket
  fields against the last API response (`src/flightDebug.ts`) and logs an error on any difference.
- **Known limitation:** when SerpApi returns results, the leg's options are flights only; curated ground
  alternatives (train/bus) for that corridor are not merged in.

## 9. Reliability Conventions
- Async Express handlers wrap their bodies in `try/catch` (Express 4 does not catch rejected promises).
- Redis and SerpApi failures never fail a request: cache errors degrade to a miss, live-API errors
  fall back to curated/synthesized corridors; a failed leg falls back to the synchronous builder.
- Client: optimistic update first, server reconcile second; stale `recompute` responses are discarded
  via a monotonic request id. `<ErrorBoundary>` wraps the app and, separately, the map.
- Leg ids are unique per itinerary (`buildLegIds` suffixes repeated corridors `-2`, `-3`).
