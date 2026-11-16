# Astris Travel — System & Architecture Reference

> Source of truth for system design, the Smart Score (VTTS) engine, and the affiliate booking flow.
> Last synced with the codebase: 2026-11-14 (direct merchant links, ground corridors, stays). If you change a path, env var, endpoint, or scoring
> constant, update this file in the same commit.

## 1. Project Overview & Core Philosophy
**Astris Travel** is a multi-destination travel planning and booking app. Instead of dumping raw
listings, it ranks multi-modal routes (flight / train / bus / ferry) **and places to stay** with a
**Smart Score** built on **VTTS (Value of Travel Time Savings)** tuned to the traveler's pacing and
preferences and maps airport-to-airport flights and
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
| `USE_REAL_DATA` | no (`false`) | `server/env.ts` `useRealData()` | `true` = live SerpApi fares, `false` = sample data only (no SerpApi or Redis fare requests). Overrides `USE_REAL_TICKET_DATA` in `shared/config.ts`, which is the in-code default (`false`). **Vercel: set it to `true` for the environment that should be live.** |
| `SERPAPI_KEY` | no | `server/transitService.ts` | Live Google Flights search (`engine=google_flights`); only used when `USE_REAL_DATA` is on. Absent → curated/synthesized corridors |
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
| **Live Flight Discovery** | **SerpApi** (`engine=google_flights`) | `fetchSerpApiFlights` in `server/transitService.ts`. One-way = `type=2`; return = `type=1` + `return_date` (price is the round-trip total). `type` must always be sent: SerpApi defaults to round-trip and answers HTTP 400 without a return date, which is why live fares never loaded before. Stop codes are expanded to real airports (`LON` → `LHR,LGW,STN,LTN,LCY,SEN`); metro codes return nothing. Parses `best_flights`/`other_flights` into `TransitOption`s (price, hops, layovers, emissions). 8s timeout; any failure falls back silently. |
| **Fallback corridors** | `CURATED_CORRIDOR_OPTIONS` + `synthesizeCorridorOptions` | Hand-authored options for the default trip's corridors; every other pair is synthesized (flight / 1-stop / rail / coach) from great-circle distance. |
| **Global Airport Data** | **`airports`** (npm) | `server/airportService.ts`: autocomplete (`searchAirports`) and IATA → exact tarmac lat/lng (`getAirportByIata`). Registered into `shared/airports.ts` at startup and used for every flight segment (§7). |
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
│   ├── smartScore.ts            # VTTS / Smart Score engine, corridor synthesis, leg building
│   ├── affiliate.ts             # Direct merchant deep links: Trip.com, FlixBus, 12Go, Booking.com, Agoda
│   ├── airports.ts              # Airport anchoring: exact airport coords, city↔airport codes, ground connectors
│   ├── groundRouting.ts         # Land network + Dijkstra + Catmull-Rom smoothing for ground polylines
│   ├── stays.ts                 # Stay categories per stop (cheapest first), partner links
│   ├── types.ts                 # TransitOption, SmartScoreBreakdown, TravelerProfile, Trip, ...
│   ├── mockDataset.ts           # Default trip, destination hubs, curated corridors
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
│       ├── SmartScoreBadge.tsx        # The Smart Score pill used on every transport card
│       ├── VttsControlPanel.tsx       # Pacing slider / preset tiers
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
| `GET /api/config` | `{ dataMode: 'live' \| 'mock' }`, read-only; drives the header's "Sample data" / "Live fares" chip |
| `GET /api/rates` | USD-based exchange rates for the currency switcher (Frankfurter / ECB, 12 h in-memory cache, built-in fallback table) |
| `GET /api/affiliate/config` | Validated partner ids for the browser's link builders (public by nature: every link carries them) |
| `GET\|POST /api/transit/query` | Single-corridor query through the Redis wrapper (`X-Cache-*` headers); optional `returnDate` for return fares |
| `GET /api/transit/cache/status` | Redis health |
| `POST /api/legs/recompute` | Re-query every leg after stop/VTTS/ticket-type change (concurrent, with per-leg fallback). Accepts `legPrefs` (`{ legId: { type: 'one-way' \| 'return', returnDate? } }`); returns legs with both fare structures settled (§11) |
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
| **price** | `basePriceUsd`, the fare per person (there are no vouchers or discounts) |
| **Pacing → r** | 0 % → $5/hr, 50 % → $15/hr, 100 % → $35/hr (piecewise linear, `pacingPercentToHourlyRate`). Presets: Backpacker $5, Balanced $15, Express $35 |
| **inVehicle** | `inVehicleHours × r × modeMultiplier` (overnight sleeper = 0.4, otherwise 1.0) |
| **layover** | Non-linear, in effective hours × *r* (`layoverEffectiveHours`): **<2 h** 0.25/h; **2–4 h** linear, +1.0/h from a 0.5 h baseline; **>4 h** `2.5 + Δ + 0.5·(e^{0.4Δ} − 1)` where Δ = hours beyond 4 (capped at 12 for the exponent). Continuous at 2 h and 4 h. If a >4 h layover overlaps 23:00–05:00 the option gets the `overnight-layover` flag and +1.5 effective hours. |
| **timeOfDay** | Multiplier on (inVehicle + layover). Departure: 00:00–04:59 ×1.25 (`red-eye`), 05:00–05:59 ×1.15 (`early-departure`), 06:00–06:59 ×1.05, 22:00+ ×1.08. Arrival: 00:00–05:59 ×1.2 (`late-arrival`), 22:00+ ×1.08. Product capped at 1.6. **Disabled** by `profile.allowRedEyes` and for overnight sleepers. |
| **transfer** | `stopsCount` > 0 → `max(0.75 × (n + 0.25·n(n−1)/2) × r, $8 × n)` — escalating 25 % per extra connection; flag `multi-stop` |
| **airportChange** | If consecutive segments' `toCode ≠ next fromCode` (e.g. arrive IST, depart SAW): `max(2.5 × r, $25)`, ×1.5 when the layover is under 4 h; flag `airport-change` |
| **weights** | `TravelerProfile { priceWeight = 1.5, timeWeight = 1.0, allowRedEyes = false }`, each clamped to [0.1, 5]. `profileFromTimeSensitivity(0..1)` maps a slider to weights (0 → 2.25 / 0.5, 0.5 → defaults, 1 → 0.75 / 1.5). |

`computeSmartScore(option, hourlyRate, profile?)` returns a `SmartScoreBreakdown`
containing every term, the weights, and `flags` (rendered as chips in `LegTransitPanel`).
Each call is O(1) (~1.5 µs); the slider re-scores all options client-side on every tick.
`recalculateOptions` scores every option and ranks them (§13).

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
  `inVehicleHours`, `basePriceUsd` directly from the option (no local arrays);
  cards expose `data-option-id`, `data-route-code`, `data-price`, `data-source` for inspection.
- **Dev logging:** server prints `[Flight Data] <label> <leg> selected=… src=… | carrier flight | dep → arr
  | $price`; the browser logs `[Flights] … → state` tables and, after every state change, checks the ticket
  fields against the last API response (`src/flightDebug.ts`) and logs an error on any difference.
- **Live flights + ground together:** a leg's list is the live flights plus the ground options for that
  corridor. There is no live availability API for trains, coaches or ferries, so those stay
  curated/estimated (**Sample** / **Estimate** chips) with a direct merchant link each; only flights carry
  **Live fare**. Ground options are rebuilt on every request and never cached.
- **Live carrier details:** live options carry `hops[]` (flight number, airline, logo, aircraft, local
  departure/arrival, duration) and `layovers[]` (airport, minutes, overnight). Cards render them per hop
  with the date, the exact fare and the merchant link.
- **Prices are per traveller.** Search results and cards are per person; the party size goes into the
  booking link (`quantity`/`adult`/`people`), where the merchant totals it.
- **Cache keys:** `transit:cache:{from}:{to}:{date}:{mode}` for one-way and `…:rt:{returnDate}` for a return
  search, 12 h TTL, live results only (Upstash Redis with an in-process L1). Return fares are only fetched
  when a leg is paired or the traveller chose Return, so the extra provider calls stay bounded.
- **No flash of sample data:** when a leg's fare search is unchanged (same date, route and travellers: its
  `fareKey`) an edit keeps the live fares already on screen while the server refreshes.

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
- **Stay ranking.** Stays are not Smart Scored: categories are listed cheapest first by the stay total (see §21).
  Hostel prices are per bed (× adults); other categories per room (`ceil(adults / 2)` rooms).

## 11. Ticket Types & Fare Comparison — `shared/fares.ts`

- **Per-leg selector.** Every leg has **One-way / Return** (`TripLeg.ticketType`). A traveller's choice is
  stored in `Trip.legPrefs[legId]` (`{ type, returnDate? }`) and always wins; without one the choice is
  automatic.
- **Both structures are kept.** `oneWayOptions` and `returnOptions` live side by side on the leg;
  `transitOptions` is the list for the current type (so cards, map and totals read one field).
  `finalizeLegs` settles the type and is the only place that swaps the list.
- **Return pricing.** A live return option's `basePriceUsd` is the real round-trip total
  (`ticketType: 'return'`, `returnDate`). Ground, and flights when no live return fare exists, use
  `deriveReturnOptions`: the one-way price twice, flagged **Estimate** (never a quoted return fare).
  Return options are scored on both journeys (`journeys: 2` multiplies the time and comfort terms in the
  Smart Score; price is paid once).
- **Pairing.** `pairStops` pairs leg *i* (A → B) with the nearest later leg *j* that comes back (B → A, by
  metro code or within 30 km). A return ticket on *i* **covers** *j* (`coveredByLegId`): its card says so,
  has no Book button, and adds nothing to the trip totals (`legTotals`).
- **Return date.** The traveller's date, else the paired leg's departure date, else the day they leave the
  destination; never before the outbound date.
- **Comparison (`compareFares`).** For a paired leg it prices *cheapest one-way here + cheapest one-way on
  the paired leg* against *cheapest return fare*, flights only when all three lists have live flights
  (`basis: 'live'`), otherwise `basis: 'estimate'`. Within $0.50 is a tie (one-way wins: more flexible).
  - **Live:** the cheaper structure is selected automatically ("Selected automatically") and the card shows
    both totals and the saving. If the traveller picked the other one, it offers "Switch to … · save $N".
  - **Estimate:** shown as informational only; estimates never switch a ticket. "Pick the cheapest for me"
    clears the traveller's choice.
- **Links.** Flights: Trip.com `triptype=rt&rdate=…` (normalised by Trip.com to its return search). Ground:
  merchants sell each direction, so a return option has two buttons, outbound and way back
  (`returnBookingUrl`, the same search reversed on the return date).
- **Optimizer.** Route optimization scores candidates with the same totals (`legTotals`), so a return
  ticket is counted once, and drops duplicate orderings that recurring stops would otherwise produce.
  It still ranks with estimated corridors; *Apply* takes only the stop order and re-queries live fares.

## 12. Vercel

`vercel.json` serves the Vite build from `dist` and rewrites `/api/*` to the single function
`api/index.ts` (`createApp()` from `server.ts`, `maxDuration` 30). Everything above runs inside that one
Express app: SerpApi + Upstash calls happen per request, the in-process cache is per instance (Upstash is
the shared one), and nothing needs a long-running process.

## 13. Data Mode, Currency, Baggage, Tags & Ranking

- **Sample vs live (`shared/config.ts`, `useRealData()` in `server/env.ts`).** One flag,
  `USE_REAL_TICKET_DATA = false` in code, overridable per environment with `USE_REAL_DATA`. When off,
  `queryTransitWithCache` never calls SerpApi **and never reads or writes the Redis fare cache**, so page
  loads, reloads and edits spend no credits; the app runs entirely on curated/estimated tickets. Server
  start logs which mode is active. The header shows "Sample data" or "Live fares" (information only; there
  is no UI switch). Ground transport is curated/estimated in both modes.
- **Same shape either way.** Sample options carry everything live ones do (price, direct/layover data,
  baggage, flight-by-flight breakdown) because `completeTicketDetails` (`shared/ticketDetails.ts`, called
  from `attachBookingUrls`) derives what is missing, never overwriting provider data.
- **Currency (`shared/currency.ts`, `src/currency.tsx`).** Everything is computed and ranked in USD; the
  header selector (USD, MYR, EUR, GBP, TRY, JPY, SGD) only changes display through `useCurrency().fmt(usd)`.
  Switching never re-queries fares and never changes a ranking. Rates come from `/api/rates`; the choice is
  kept in `localStorage`. Smart Score is a unit-less points figure and is not converted.
- **Baggage (`BaggageInfo` on `TransitOption.baggage`).** Live fares: `parseBaggage` reads carry-on /
  checked-bag phrases from the fare's amenity strings. In practice many SerpApi fares state none, so the
  fallback is the carrier's typical economy policy (`typicalBaggage`: full-service = carry-on + 1 × 23 kg,
  low-cost = carry-on, checked for a fee, "Saver/Basic/Light" fares = no checked bag, coach 1 × 25 kg,
  rail/ferry included). Typical values are tagged `source: 'typical'` and shown with a "typical" marker and
  a tooltip to confirm at booking; they are never presented as a fare rule.
- **Card layout.** Each card shows the main flight legs (`hops`) with layovers and baggage. The repeated
  transfer / step summary line below them (`KUL → KUL transfer (49m)`, `MH 160 (475m) → QR 237 …`) is gone.
- **Ranking and tags (`shared/ranking.ts`).** `recalculateOptions` ends in `rankAndTag`,
  so every list is ordered: 1) best Smart Score, 2) cheapest direct (if not already 1st), 3) cheapest overall
  (if not already placed), 4) the rest by Smart Score. Tags: `Direct` (no stops, no layover),
  `Cheapest Direct` (lowest-priced direct), `Cheapest` (lowest-priced overall); one ticket can carry several.
  "Price" is the fare per person; ties go to the better Smart Score.

## 14. Boarding-Pass Flight Cards — `src/components/BoardingPass.tsx`

- **Where.** `LegTransitPanel` renders every `mode === 'flight'` option as a boarding pass; trains, coaches
  and ferries keep the compact card (they have no airline brand, flight legs or aircraft).
- **Anatomy.** Brand-coloured header across the pass (airplane, operating airlines, `ONE-WAY` / `RETURN`,
  `Selected`; right side `FARE SUMMARY · class`), a decorative barcode edge, a main body (FLIGHT / DATE /
  DURATION / STOPS row, origin and destination IATA codes joined by a flight path with times, a one-line
  flight-by-flight detail for multi-flight tickets, and the `Direct` / `Cheapest Direct` / `Cheapest`
  pills pinned to the bottom-left beside the barcode), a perforated tear line with punched notches, and a
  stub (baggage, price in the selected currency, Smart Score, mini barcode, Book button). A faint airplane
  watermark sits behind the route. The old transfer/step summary lines are not rendered.
- **Responsive by container width, not screen width.** The pass sits inside a Tailwind `@container` and
  switches layout at `@[28rem]` (448 px of its own width; the pane card is ~486 px at 100 % zoom on a 150 %-scaled laptop, which the old 512 px threshold missed, so it rendered as a stacked square): wider = main body 2/3 / stub 1/3 with a vertical
  dashed tear line; narrower = stub below with a horizontal tear line and side notches. This matters
  because the itinerary pane is only about 550 px wide on a laptop even though the screen is wide.
- **Airline colours (`src/utils/airlineColors.ts`).** IATA code → `{ color, text }` for ~60 carriers (name
  lookup as a fallback, `#0284C7` for anything unmapped). `ticketAirlines` lists the operating airlines of a
  ticket once each in flight order (from the flight-by-flight breakdown). `ticketPalette` gives the header,
  bottom strip and Book button either that airline's colour or, for several airlines,
  `linear-gradient(90deg, c1, c2, …)`; the text colour is picked so it is legible over every stop of the
  gradient (white unless contrast drops below ~3.2, then dark slate). Route-line and plane accents use the
  first airline's colour, darkened when it would be too pale on white.
- **Barcodes are decorative** (seeded from the option id, so each looks different but is stable), not
  scannable and not tied to a booking.

## 15. Bus and Train Tickets — `src/components/GroundTicket.tsx`

Coaches and trains are drawn as tickets too (ferries keep the compact card). Both use the same container-query
approach (`@[28rem]`) and the same data as flights: tags, baggage line, price, Smart Score, Book button.

- **Bus (lime `#abed00`).** Scalloped left/right edges with dotted perforations, a darker-lime inner panel with
  an olive outline, `BUS TICKET` title, route, date/duration/stops/service, a ticket-number line, a vertical
  barcode on the right and a dashed stub with baggage, fare and an olive Book button. Wide cards put the stub
  beside the route (landscape); narrow cards stack it below.
- **Train (purple `#5600D6`).** Rail-ticket style: purple header band (`OPERATOR · TRAIN TICKET`, `OUTWARD`/`RETURN`),
  cream monospaced body with the operator name faintly repeated behind it, from/to with times, and a purple
  fare band separated by a perforation with side notches, holding the price and a white Book button.
- Large codes are the leg's city codes; station names sit underneath. Ticket numbers are decorative.

## 16. Flight Booking Comparison Panel — `src/components/BookingOffers.tsx`

The stub button on every boarding pass is `PROCEED TO BOOKING` (in the ticket's brand colour). It opens one
floating panel (a portal on `document.body`, `border-2 border-orange-500 shadow-xl`) listing the merchants that
sell the flight, cheapest first; the cheapest has the orange `Buy` button, the rest light grey.

- **Data.** `attachBookingUrls` adds `offers: AffiliateOffer[]` to every flight (sample and live alike), built by
  `buildFlightOffers` in `shared/affiliate.ts`: Trip.com (the ticket's own deep link and real fare), Kiwi.com
  (`/deep?from&to&departure&return`), Skyscanner (`/transport/flights/{from}/{to}/{yymmdd}/…`) and Google Flights
  (`?q=…`). There is no price API for the non-primary merchants, so theirs are the fare plus a fixed 1–6.5 %
  (hashed from the ticket id, so stable) and carry `estimated: true`; the panel says so. This also guarantees the
  cheapest offer equals the price on the stub. Kiwi and Skyscanner links are unverified against the live sites'
  current URL schemes, and only Trip.com carries an affiliate id.
- **Prices** are USD in the data and converted with `useCurrency().fmt`; the cheapest row always equals the price on
  the stub.
- **Behaviour.** One panel at a time (module-level store, so opening another card's panel switches to it); closes
  on Escape, an outside click, or when the card scrolls out of view; follows the card on scroll/resize. It sits to
  the right of the card when there is room (≥ 220 px, viewport ≥ 768 px), otherwise it is a centred modal with a
  backdrop. Ground tickets keep their single Book button.

## 17. Recent Real Fares in Sample Mode — `server/travelpayoutsService.ts`

With `USE_REAL_DATA` off the flights used to be fully invented. When `TRAVELPAYOUTS_TOKEN` is set, the server asks
the free Aviasales Data API (`/aviasales/v3/prices_for_dates`, token in the `X-Access-Token` header, prices in USD)
for the cheapest fare and the cheapest non-stop for the leg's date (round-trip total for return tickets) and shows
those as `dataSource: 'cached'` ("Recent fare" chip) instead of the sample flights. No SerpApi credit is spent.

- **What the data is.** Fares other travellers found on Aviasales in the last ~48 h: real, but possibly moved, and
  only for routes someone searched. When there is nothing for the exact date, the nearest cached day within ±3 days
  is used (the ticket shows its own date); with nothing at all the leg keeps the sample flights. Results are cached
  12 h (Redis + memory, key `…:tp2`).
- **What is missing, and how it is handled.** The payload has no baggage, layover airports or per-flight list: baggage
  is the carrier's typical policy (marked "typical"), connections show `n STOP · hours` without a flight list, and
  the in-flight/layover split behind the Smart Score is estimated from the distance. Arrival times use the
  destination time zone from Aviasales' public `airports.json` (loaded once per instance, with `airlines.json` for
  carrier names). Departure times are read as written (local).
- **Booking panel.** A cached ticket's cheapest row is Aviasales itself (the fare's own results page, with
  `TRAVELPAYOUTS_MARKER` appended when set); Trip.com and the others are estimates just above it.
- **Rules that follow.** `cached` counts as a real fare for the one-way vs return comparison and for reusing earlier
  results; a return derived from a cached one-way is an estimate. With `USE_REAL_DATA` on, SerpApi is used as before
  and this service is not called. A rejected or missing token degrades to the sample flights.

## 18. Partner Ids — `shared/config.ts`

- **Trip.com** (flights, trains, hotels): `Allianceid`, `SID` and `trip_sub3` (+ an empty `trip_sub1`, the shape of Trip.com's
  own partner links) are appended to every Trip.com link. They default to `AFFILIATE_DEFAULTS.tripcom*`; `TRIPCOM_ALLIANCE_ID`,
  `TRIPCOM_SID`, `TRIPCOM_SUB3` (or `VITE_TRIP_ALLIANCE_ID` / `VITE_TRIP_SID`) override them on the server, which also hands
  them to the browser via `GET /api/affiliate/config`.
  - **Flights:** `buildTripFlightUrl({ originIata, destinationIata, departureDate, tripType: 'ow' | 'rt', … })` builds
    `…/flights/showfarefirst?dcity&acity&ddate&triptype&…` (metro codes, airport codes where a city has several, `rdate` for a
    round trip, party size, single-airline filter). `buildTripcomFlightUrl` feeds it each ticket's own airports, date and way-back
    date, so the card's Book button and the Trip.com row of the booking panel open the exact route and date.
  - **Hotels:** `…/hotels/list?city=<id>&display=…&optionId=<id>&optionType=City&optionName=…&checkin&checkout&adult&crn` when the
    city's Trip.com id is known (`TRIPCOM_CITY_IDS`, currently Istanbul 532 only, read from a Trip.com link), otherwise a text
    search (`cityName`, `searchWord`). Add ids by copying `city=` from a Trip.com hotel search.
  - **Trains:** Trip.com's train search needs internal station codes (`departurecitycode=GB1594`) we do not have, so each train
    ticket gets an "or on Trip.com" link to the train page with the ids (`tripcomTrainsHome`); 12Go stays the main button.
- **12Go** (coaches, trains, ferries) takes `z=<id>`; default `AFFILIATE_DEFAULTS.twelveGoAffiliateId` (`17520220`).
- **Aviasales** fare links (recent fares in sample mode) get `marker=`; default `AFFILIATE_DEFAULTS.travelpayoutsMarker` (`806003`).
- All are public ids (every outbound link carries them), so defaults are safe; an environment variable overrides them.
- Booking.com and Agoda keep their exact-search deep links without affiliate ids until ids are configured.

## 19. Ticket Shapes — `src/index.css`, `src/useTicketMask.ts`

Tickets are drawn as their true shapes, not rectangles with white circles painted on. Notches and scalloped edges
are real holes cut with CSS `mask-image` on the inner ticket element (`.mask-bp`, `.mask-bus`, `.mask-train`); the
outline and shadow are chained `drop-shadow()` filters on the wrapper (`.ticket-shape`), so they follow the cut-outs
(a filter on the same element as the mask would run before it and be cut away). A selected ticket
(`data-selected`) gets an orange outline, lifts 4 px, slides right by 8.6 % of its own width and gets a larger soft black shadow (drawn beneath neighbouring tickets, so it never overlaps them). `useTicketMask` measures the
seam (stub top / fare band) into `--tear-y` and picks `--pitch` so whole scallops fit the bus ticket's height.

## 20. Ground Schedules — transit directions and 12Go timetables

`GET /api/ground/schedules` (coordinates, city and country names, date, party size) returns
`{ google: { enabled, routes }, twelveGo: { supported, routes } }` (`shared/groundSchedule.ts`). The leg panel
(`GroundSchedulePanel`, shown for legs under ~1,800 km or with a coach/train option) loads it when the leg is open and
hides itself when both parts are empty. Both parts are cached 7 days (`server/jsonCache.ts`: Upstash Redis + memory).

- **Google Routes** (`server/googleRoutesService.ts`): `POST …/directions/v2:computeRoutes`, `travelMode: TRANSIT`,
  alternatives on, allowed modes BUS/TRAIN/SUBWAY/RAIL, key in `GOOGLE_MAPS_API_KEY` (server only), field mask limited
  to what is parsed. Each route becomes walk and transit steps (line, agency, headsign, stops, local times, fare when
  Google gives one) with a decoded polyline per step. It is paid per request, so it only runs with a key, only for an
  opened leg, and the cache key is origin, destination, modes **and date** (timetables differ by day). The chosen
  route is drawn on the map (`astris-transit-overlay`): trains solid blue, metro/trams dashed blue, buses orange,
  walking dotted grey; the map fits to it. Tested against documented response shapes only, not a live key.
- **12Go** (`server/twelveGoService.ts`): fetches the partner timetable page
  (`/en/timetable/{TH|MY|KH|VN|SG}/{from}/{to}?embedded`), parses routes out of the HTML server-side (markup is never
  forwarded), and rebuilds every link on `12go.asia` with `z=<partner id>`, `curr`, the date and the party size. The
  page gives class labels (Express, VIP…), departure times and price/duration ranges but no operator names, so none
  are shown; flights are skipped (the flight cards cover them). Cached by country/origin/destination; date and party
  size are applied when serving.

## 21. Live Hotels — `server/hotelService.ts`, `src/components/HotelCards.tsx`

In live-data mode (`USE_REAL_DATA`, with `SERPAPI_KEY`) each stop's "Staying in [City]?" card, when opened, loads real
hotels from Google Hotels through SerpApi (`engine=google_hotels`, `q` city, check-in/out, adults, USD). One search
costs one credit, so it runs only for an opened stop and is cached 24 h (`hotels:v1:…`, Redis + memory). In sample mode
`GET /api/hotels/search` answers `enabled: false` without calling out and the section does not render; the estimated
stay categories below it are unchanged.

- **Card.** A ticket-shaped card (same mask, outline and notch as the boarding pass): thumbnail, name, type, stars,
  review score and count, up to four amenity badges, a deal label when Google shows one, and a stub with the nightly
  rate, the stay total and `PROCEED TO BOOKING`. Properties without a price are dropped. Only amenities Google lists
  without "($)" get a badge, so "Breakfast ($)" is not shown as included.
- **Booking panel.** `OffersButton` (the generic floating panel behind the flight booking button) lists the property's
  own site or Google Hotels with the live price first, then Booking.com and Trip.com (both searched by property name)
  and Agoda (city search, only for cities with a known id; Agoda takes no free text). Their prices are not known, so
  they say "Check price". Partner ids are added where configured; Trip.com's hotel URL parameters are unverified.
- **Hotels are not Smart Scored.** The estimated categories (`shared/stays.ts`) and the live hotels are both listed
  cheapest first by the stay total; the old stay scoring (commute and comfort penalties, hourly rate, traveller
  profile) is gone, and the first category is tagged "Cheapest".
- **Live hotel sort and filters.** Sort: lowest price (default), highest price, top rated, most reviewed, star class,
  best match (Google's order). Filters: minimum guest rating (3.5+/4+/4.5+), minimum stars, maximum nightly price
  (slider over the results' range), included amenities (only free ones count, as for the badges), property type and
  deals only, with a result count and reset. Choices that no result could satisfy are not offered. The estimated
  categories are a fixed list of six and are not filtered.

## 22. Route Bar — `src/components/RouteBar.tsx`

A floating glass bar at the top of the map replaces the old floating transport-mode chips. It edits the same
trip state as the itinerary list (`trip.stops`, `trip.legPrefs`), so the two always agree.

- **Stop pills**, in route order and numbered like the map pins: drag one onto another to move it, or use the
  left/right arrows that slide out on hover or keyboard focus (the × removes a stop while more than two remain).
  Moves go through the same `reorderStops` as the list's drag handle (dates after the move are recalculated).
  Hovering a pill highlights the stop in the list and on the map; clicking its name flies the map there.
- **Connectors** between pills: `→` one-way, `⇄` return (also shown, dimmed, on a leg a return ticket already
  covers). Clicking opens a menu: One-way, Return, or Best price (auto, which hands the choice back to the
  cheaper-fare logic of §11). On a covered leg the menu offers "Book one-way tickets instead".
- **Add a stop…** is an inline typeahead (`/api/airports/search`, falling back to the popular destinations) that
  appends the stop through `handleAddDestination`.
- **Transport filter** is not in the bar: it is the chip row above the itinerary (`TransportFilter.tsx`: All / Flights / Trains /
  Buses with counts), filtering every leg's ticket list and the map lines through the shared `modeFilter`.
- **Search** re-runs the whole route through `/api/legs/recompute` (flights, trains and buses for every leg) with a
  spinner, then re-frames the map; the polylines follow the new legs. Edits made in the bar already recompute
  immediately, so Search is for refreshing, not for applying pending edits.
- Menus render in portals so the bar's pills never clip them.
