# Astris Travel — System & Architecture Reference

> Source of truth for system design, the Smart Score (VTTS) engine, and the affiliate booking flow.
> Last synced with the codebase: 2026-11-14 (direct merchant links, ground corridors, stays). If you change a path, env var, endpoint, or scoring
> constant, update this file in the same commit.

## 1. Project Overview & Core Philosophy
**Astris Travel** is a multi-destination travel planning and booking app. Instead of dumping raw
listings, it ranks multi-modal routes (flight / train / bus / ferry) **and places to stay** with a
**Smart Score** built on **VTTS (Value of Travel Time Savings)** tuned to the traveler's pacing and
preferences, applies promo vouchers before ranking, and maps airport-to-airport flights and
land-following ground corridors. Outbound links go straight to the merchant (Trip.com, FlixBus, 12Go,
Booking.com, Agoda) with the selected option's parameters filled in.

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
| `TRIPCOM_ALLIANCE_ID`, `TRIPCOM_SID` | no | `shared/affiliate.ts` (configured in `transitService.ts`) | Trip.com partner pair, sent as `Allianceid` + `SID` on flight links. Both are needed. Absent → links work but are **not attributed** |
| `BOOKING_AID` | no | same | Booking.com affiliate id, sent as `aid` on stay links |
| `AGODA_CID` | no | same | Agoda partner id, sent as `cid` on stay links |
| `TWELVEGO_AFFILIATE_ID` | no | same | 12Go partner id, sent as `z` on train / ferry / coach links |
| `TRIPCOM_TRACKING_TEMPLATE`, `FLIXBUS_…`, `TWELVEGO_…`, `BOOKING_…`, `AGODA_…` | no | same | For programs run through a network (FlixBus on Awin, anything on Travelpayouts/CJ): an https URL containing `{url}`, which is replaced with the encoded deep link |
| `FLIXBUS_CITY_LOOKUP` | no (on) | `server/flixbusService.ts` | `off` disables the FlixBus city-id lookup; FlixBus coaches then link to 12Go |
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
| **Affiliate Monetization** | **Trip.com, FlixBus, 12Go, Booking.com, Agoda** (direct) | `shared/affiliate.ts` — see §6. The former Travelpayouts/Aviasales and Rome2Rio links are gone; `TRAVELPAYOUTS_*` variables are no longer read. |
| **FlixBus city ids** | flixbus.com public city autocomplete | `server/flixbusService.ts`: city name + coordinates → FlixBus UUID, cached 24 h. Undocumented endpoint: every failure means "no FlixBus link". |
| **Ground corridors** | built-in network (no API) | `shared/groundRouting.ts` — see §7. |
| **Stays** | built-in estimates (no inventory API) | `shared/stays.ts` — see §10. |
| **Ticket Fulfillment** | **Duffel API** *(Phase 2, not implemented)* | Planned: offer requests, single-offer pricing, ancillaries, order creation. `@duffel/api` is not yet a dependency. |

---

## 4. Core File Architecture
```text
├── server.ts                    # Express entry: API routes, input validation, Vite middleware / static serving
├── server/
│   ├── env.ts                   # dotenv bootstrap (.env.local → .env), getEnv(), missing-key warnings — import FIRST
│   ├── transitService.ts        # SerpApi integration, Redis cache wrapper, coordinate resolution, fallback corridors
│   ├── airportService.ts        # `airports` dataset search + IATA lookup
│   └── flixbusService.ts        # FlixBus city-id lookup (cached) for FlixBus deep links
├── shared/                      # Imported by server AND client
│   ├── smartScore.ts            # VTTS / Smart Score engine, vouchers math, corridor synthesis, leg building
│   ├── affiliate.ts             # Direct merchant deep links: Trip.com, FlixBus, 12Go, Booking.com, Agoda
│   ├── airports.ts              # Airport anchoring: exact airport coords, city↔airport codes, ground connectors
│   ├── groundRouting.ts         # Land network + Dijkstra + Catmull-Rom smoothing for ground polylines
│   ├── stays.ts                 # Stay categories per stop, stay Smart Score, partner links
│   ├── types.ts                 # TransitOption, SmartScoreBreakdown, TravelerProfile, Trip, ...
│   ├── mockDataset.ts           # Default trip, destination hubs, vouchers, curated corridors
│   └── dateUtils.ts             # Stop date recalculation after reorder; origin = departure date only
├── src/
│   ├── main.tsx                 # React root wrapped in <ErrorBoundary>
│   ├── App.tsx                  # State owner: trip, optimistic recompute, API calls, layout
│   └── components/
│       ├── ErrorBoundary.tsx          # Render-error containment (app-level + map-level)
│       ├── TopBar.tsx
│       ├── SortableStopCard.tsx       # Draggable stop in the timeline (no night counter on the origin)
│       ├── LegTransitPanel.tsx        # Ranked options per leg: score, flag chips, merchant button
│       ├── StayPanel.tsx              # "Staying in [City]?" card: ranked stay categories + Booking.com / Agoda
│       ├── SmartScoreBadge.tsx        # The Smart Score pill used on every transport and stay card
│       ├── VttsControlPanel.tsx       # Pacing slider / preset tiers
│       ├── VoucherDrawer.tsx          # Promo entry + savings preview
│       ├── AddStopModal.tsx           # Airport autocomplete (`/api/airports/search`)
│       ├── MultiDestDatePickerModal.tsx
│       ├── RouteOptimizerModal.tsx    # Two-stage optimizer results
│       └── WorldMapCanvas.tsx         # MapLibre map: airport-to-airport flight arcs, dashed airport connectors, land-following ground lines
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
| `GET /api/affiliate/config` | Validated partner ids for the browser's link builders (public by nature: every link carries them) |
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

## 6. Direct Merchant Links — `shared/affiliate.ts`

Every outbound link lands on the site that sells the ticket or room, with the search already filled
in from the card that was clicked. No metasearch page sits in between. The URL formats below were
checked against the live sites (2026-11).

| Option | Merchant | URL |
| :--- | :--- | :--- |
| Flight | **Trip.com** | `trip.com/flights/showfarefirst?dcity=ist&acity=lon&dairport=saw&aairport=stn&ddate=2026-11-26&triptype=ow&class=y&quantity=2&airline=PC` |
| FlixBus coach | **FlixBus** | `shop.flixbus.com/search?departureCity={uuid}&arrivalCity={uuid}&rideDate=30.11.2026&adult=2` |
| Train, ferry, other coaches | **12Go** | `12go.asia/en/travel/london/paris?date=2026-11-30&people=2` |
| Stay | **Booking.com** | `booking.com/searchresults.html?ss=Paris, France&checkin=…&checkout=…&group_adults=2&no_rooms=1&nflt=class=4;ht_id=204` |
| Stay | **Agoda** | `agoda.com/search?city=15470&checkIn=…&checkOut=…&los=4&rooms=1&adults=2` |

**Exact ticket matching** (`buildTripcomFlightUrl`):
- **Airports** come from the option's own first and last flight segments, not the stop: a London stop
  is `LON`, but a Pegasus fare leaves Sabiha Gökçen for Stansted, so the link says
  `dcity=ist&dairport=saw … acity=lon&aairport=stn` (`toMetroCode` maps airport → city code).
- **Date** is the provider's `departureAt` when present, otherwise the leg's departure date. Impossible
  dates (Feb 31) are rejected.
- **Passengers** come from `trip.travelers` (1–9; the stepper in the trip header).
- **Airline** (`airline=PC`) is passed only when one real carrier operates the whole ticket. Estimated
  options use made-up services and interline tickets have no single airline; filtering either would
  land on an empty page, so those links carry route, date and passengers only.
- An unusable route or date links to the merchant's own search page, never an empty URL.

**Ground:** a coach branded FlixBus gets a FlixBus link when the server resolved both city ids
(`server/flixbusService.ts`); everything else on the ground goes to 12Go by city slug.

**Stays:** `buildBookingStayUrl` passes city, check-in/out, adults, rooms and the card's property filter
(`class=N` stars, `ht_id` 204 hotel / 203 hostel / 201 apartment). Agoda's search accepts only numeric
city ids, so `AGODA_CITY_IDS` (read from Agoda's own city pages) decides whether an Agoda button is
shown at all; an unknown city gets Booking.com only rather than an approximate Agoda page.

**Attribution:** the merchant's own parameter is appended to the same URL (`Allianceid`+`SID`, `aid`,
`cid`, `z`). Programs that run through a network use a per-merchant tracking template whose `{url}` is
replaced by the encoded deep link. The server validates ids at startup (`configureAffiliate`) and the
browser fetches the same ids from `/api/affiliate/config`, so client-built links (stays, optimistic
transport links) are attributed too. FlixBus ids exist only server-side: an optimistic coach link is a
12Go link until the server response replaces it.

**Where links are attached:** `attachBookingUrls` in `buildLegsFromStops` (default trip, optimizer,
optimistic updates) and `queryTransitWithCache` (cache hit, live, fallback); it sets `bookingUrl` and
`bookingProvider` and always overwrites stale values. `LegTransitPanel` labels the button with the
merchant (`Book on Trip.com · $218` for live fares, `Find on 12Go` for sample/estimated options),
`target="_blank"`, `rel="sponsored noopener noreferrer"`. In development the server logs each distinct
URL and the browser logs the URL on click.

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
- Client: the browser has the built-in table plus every airport it has seen (`registerAirports`: flight
  segments in API responses, stops picked from airport search). An airport in neither can only belong to
  a stop picked from airport search, whose coordinates are the airport's own, so the stop is the
  fallback. There are no invented offsets, and a live fare with an airport no dataset knows is dropped.

### Map rendering (`WorldMapCanvas.tsx`)
- Flight segments → great-circle arcs between airport nodes only (orange, solid) with labelled IATA
  **airport nodes** at each endpoint.
- Ground segments that lead to/from a flight's airport are **connectors**: dashed, in their own GeoJSON
  source/layer, so they never merge into the flight line. Curated connectors follow their real alignment
  (`CONNECTOR_TRACKS` in `mockDataset.ts`); unknown ones are a shallow arc.
- Other ground legs (intercity rail/bus) are solid lines drawn by `groundGeometry`
  (`shared/groundRouting.ts`): the segment's `waypoints` (stations) are smoothed with a centripetal
  Catmull-Rom curve, and a segment without waypoints is routed over the land network first. Station dots
  mark the stations, not polyline vertices.
- A place visited more than once shares one pin listing every stop number (`1·5`).

### Ground corridors (`shared/groundRouting.ts`)
A hand-built graph of ~300 rail/road junction cities and the fixed links between landmasses (Channel
Tunnel, Øresund, Great Belt, Bosphorus, Seikan, King Fahd Causeway). `planGroundCorridor(from, to)`
snaps both ends to the network (≤220 km), runs Dijkstra and returns:
- `routed`: the junctions in order and the routed distance. `synthesizeCorridorOptions` stores them as
  the segment's `waypoints` and uses the routed distance for duration, price and CO₂.
- `none`: both ends are on the network but not connected by land (Singapore → Jakarta, Dublin → London),
  or the land route is several times the direct distance (Helsinki → Tallinn). No train or coach is
  synthesized.
- `unknown`: an end is outside the network. The straight-line estimate is kept and the map draws a
  neutral arc.
It is not a routing engine: lines follow corridors between junction cities, not individual tracks.
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

## 10. Itinerary Rules & Stays

- **Stops may repeat.** Nothing checks uniqueness: a city can be added any number of times (the add-stop
  modal shows `In trip ×N` and still adds). Stop ids are unique per visit. Two consecutive visits to the
  same place (`isSamePlace`) produce a leg with no options, rendered as "no transport needed", and never
  query the flight API.
- **The origin is a departure point.** Stop 0 has one date (`arrivalDate === departureDate`), no night
  counter, and contributes no nights (`stopNights`, `totalTripNights` in `dateUtils.ts`). Its `stayNights`
  is kept but ignored, so a stop dragged out of first place gets its nights back.
- **Stays** (`shared/stays.ts`, `StayPanel.tsx`): every stop after the origin gets a "Staying in [City]?
  Find and compare places to stay" card under it in the timeline, and the **Stays** tab lists them all.
  There is no hotel inventory API, so a card ranks six *categories* (hostel … 5★) with an estimated
  nightly price from a city cost index, labelled **Estimate**; no property names or quoted rates are
  invented. Each category links to Booking.com / Agoda with matching city, dates, guests, rooms and filter.
- **Stay Smart Score** (`computeStaySmartScore`, lower is better, same weights and hourly rate *r* as §5):

  ```text
  score = priceWeight × (nightly × nights)
        + timeWeight  × ( commute + comfort )
  commute = nights × 4 trips × minutesToCentre/60 × r × adults
  comfort = nights × 10 h × comfortMultiplier × r × adults
  ```
  `comfortMultiplier` (dorm 0.7 … 5★ 0) is the stay-side counterpart of the sleeper's 0.4× in-vehicle
  multiplier. A low *r* ranks hostels first; raising the pacing slider moves the ranking up-market.
  Hostel prices are per bed (× adults); other categories per room (`ceil(adults / 2)` rooms).
