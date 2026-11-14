# Astris Travel — Implementation Plan

Astris Travel is a split-screen multi-destination travel planning and route optimization workspace that pairs an interactive drag-and-drop itinerary timeline with a synchronized geodesic world map, multi-modal transit comparison, Smart Score ranking, two-stage route optimization, and automatic voucher matching.

---

### User Review & Critical Decisions

> [!IMPORTANT]
> All core architectural choices below incorporate your Phase 1 answers and govern how the live preview, mapping engine, and shared data contracts are structured.

- **Confirmed Decision 1 — Hybrid Live Runtime + FastAPI Schemas**: Build a live, immediately previewable React + Vite + Express TypeScript application on port 3000 while also delivering the shared TypeScript contracts and Python FastAPI + Pydantic v2 models (`Trip`, `TripLeg`, `TransitOption`, `Voucher`) alongside the structured JSON mock dataset.
- **Confirmed Decision 2 — Token-Free MapLibre GL**: Use `react-map-gl` (MapLibre entrypoint) paired with `maplibre-gl` and `@turf/great-circle` over a clean, token-free Carto Positron vector/raster basemap so numbered destination pins and curved geodesic flight arcs render reliably with zero API key friction.
- **Confirmed Decision 3 — Full Interactive Workspace**: Ship the complete split-screen workspace upfront, including drag-and-drop stop reordering, adding/removing destinations, live Smart Score recalculation, two-stage route optimization, and interactive voucher application.
- **Confirmed Decision 4 — Mock Dataset + Express API Endpoints First**: Back the interactive client with Express `/api/*` endpoints serving and evaluating the realistic 4-stop `Kuala Lumpur → Istanbul → London → Paris` dataset (plus expandable global hubs), keeping persistence lightweight before connecting live transit feeds or PostgreSQL.

---

### 1. Overview & Core Concept

- **What It Does**: Users build and refine multi-city international itineraries in a synchronized split-screen workspace. Reordering or adding stops on the left timeline immediately updates numbered pins and great-circle flight arcs on the right map, queries multi-modal door-to-door transit options (flights, high-speed rail, and intercity coaches), ranks them via the Smart Score formula, applies eligible promo vouchers, and runs a two-stage geographical + transit optimizer to suggest better stop sequences.
- **Target Audience / Persona**: Global travelers, digital nomads, and multi-leg trip planners balancing ticket cost against travel and layover hours across air and ground transport.
- **Key Value**: Eliminates multi-tab spreadsheet planning by quantifying the true comfort-weighted, time-adjusted cost of every leg (`discountedPrice + (inVehicleHours × baseRate × modeMultiplier) + (layoverHours × baseRate × layoverMultiplier)`) and immediately visualizing route geometry and savings on one canvas.

---

### 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Initial Workspace Load**: Opens directly into the pre-loaded 4-stop trip (`1. Kuala Lumpur → 2. Istanbul → 3. London → 4. Paris`), displaying total trip cost, total travel hours, the active **Balanced Explorer (`$15/hr`)** VTTS tier, and numbered geodesic arcs across Asia and Europe.
  2. **Timeline & Map Synchronization**: Users drag stops by their grip handle to reorder the sequence, hover over any stop or leg to highlight its corresponding pin and curved arc on the map, click a leg to inspect door-to-door flight/train/bus alternatives, or add/remove stops from a searchable destination picker.
  3. **Tiered VTTS Smart Score & Multi-Modal Filtering**: Switching between the 3-tier Value of Travel Time Savings (VTTS) preset toggle (**Budget Backpacker** `$5/hr`, **Balanced Explorer** `$15/hr` default, **Time-Rich / Express** `$35/hr`), optionally expanding the advanced fine-tuning slider, or toggling the floating glassmorphic transport filter bar (`All`, `Flight`, `Train`, `Bus`) over the map dynamically recalculates pain-weighted Smart Scores and re-ranks transit cards in real time.
  4. **Two-Stage Route Optimizer**: Clicking **Optimize Route** in the top bar runs Stage 1 (local geographical permutation scoring via Haversine/great-circle distance) and Stage 2 (Express API transit evaluation of top paths), presenting a comparison drawer with net distance, hours, and cost deltas that can be applied in one click.
  5. **Voucher & Promo Matching**: Users enter a promo code or toggle matched eligible vouchers on a selected transit option; the engine validates corridor, mode, carrier, and minimum spend rules, updating the net fare and Smart Score inline.

- **Visual Identity & Theme**:
  - *Aesthetic Direction*: Modern, airy travel-tech workspace blending editorial clarity with high-precision SaaS utility (Airbnb warmth meets Wanderlog spatial structure).
  - *Color Palette & Mood*:
    - **60% Dominant Neutral Canvas**: Pure crisp white (`#FFFFFF`) cards, floating panels, and modals layered over a clean warm-neutral off-white workspace canvas (`#FAFAFA`).
    - **30% Structural Surfaces**: Deep charcoal (`#111827`) for primary headers, destination titles, and prices; neutral slate (`#4B5563`) for secondary metadata; and crisp hairline borders (`border-neutral-200/80`).
    - **10% Accent Budget**: Vibrant Sunset Orange (`#FF812E`, hover `#E56B1A`) reserved strictly for primary CTAs, active route highlights, numbered map pins, and primary geodesic flight/transit arcs, paired with soft orange tint (`#FFF4ED`) and warm border (`#FFD6BA`) for active card states.
    - **Semantic Status**: Green (`#16A34A`) for savings/applied vouchers, Amber (`#D97706`) for long layovers, Crimson (`#DC2626`) for invalid vouchers or warnings—always paired with explicit text labels.
  - *Typography & Hierarchy*:
    - Display & Headings: `Plus Jakarta Sans` (SemiBold/Bold) with `text-wrap: balance` on titles.
    - Body & Controls: `DM Sans` (Regular/Medium) at 13px–15px for crisp legibility.
    - Numeric Telemetry: `JetBrains Mono` with `font-variant-numeric: tabular-nums` for fares, Smart Scores, durations, coordinates, and promo codes.
  - *Component Styling & Layout*:
    - **Top Bar Contract**: Clean single-row header with three zones (`Astris Travel` wordmark — concise workspace section links — single `#FF812E` `Optimize Route` primary CTA).
    - **Split-Screen Master Layout**: Full-viewport `1440px` desktop split (`46%` scrollable itinerary & transit inspector on the left over `#FAFAFA`, `54%` sticky interactive MapLibre canvas on the right, responsive stacked toggle on mobile).
    - **Card & Metadata Restraint**: Single-elevation pure white `rounded-2xl` cards (`bg-white border border-neutral-200/80 shadow-sm hover:shadow-md`), active selection cards using `#FFF4ED` tint with `#FFD6BA` border, clean unboxed metadata joined by typographic separators (`·`, `/`), and zero nested card-in-card clutter or thick left accent borders.
    - **Map & Glassmorphic Controls**: Numbered destination pins (`1`, `2`, `3`, `4`...) and primary active flight/transit arcs rendered in `#FF812E` with soft white halos/outlines (`#FFFFFF`) on pins so they pop clearly against map tiles; floating segmented transport filter bar (`All`, `Flight`, `Train`, `Bus`) over the map styled with `bg-white/85 backdrop-blur-md border border-white/40 shadow-lg rounded-full`.

- **Interactive Feedback & Motion**:
  - Smooth 150–200ms transitions (`cubic-bezier(0.16, 1, 0.3, 1)`) using `transform` and `opacity` during drag sorting, leg expansion, and map camera `flyTo` transitions.
  - Complete empty state (when fewer than 2 stops remain), loading skeleton state during route optimization, and non-blocking inline error/validation feedback for promo codes.

---

### 3. Key Product Decisions & Trade-Offs

- **Decision 1 — Live Express + React Architecture Alongside FastAPI/Pydantic Blueprint**:
  - *Chosen Approach*: Serve the interactive React frontend and REST endpoints from a unified Express + Vite Node server on port 3000, while placing clean, production-ready Python FastAPI + Pydantic v2 model definitions and router specs in a dedicated backend reference module.
  - *Why*: Ensures the application launches and runs live immediately in the preview environment without requiring a separate Python ASGI runtime, while honoring the exact Pydantic v2 data contracts needed for future Python microservice deployment.
  - *Alternatives Considered*: A static Next.js + FastAPI folder scaffold was passed over because it would leave the port-3000 preview non-functional.

- **Decision 2 — MapLibre GL (`react-map-gl/maplibre`) + `@turf/great-circle`**:
  - *Chosen Approach*: Render the interactive world map with MapLibre GL and free Carto Positron vector/raster styles, drawing smooth spherical great-circle GeoJSON lines and custom HTML numbered markers.
  - *Why*: Delivers smooth pan/zoom, `flyTo` synchronization, and crisp curved arcs immediately with zero access-token failures.
  - *Alternatives Considered*: Raw Mapbox GL requires a private token that breaks in tokenless previews; static SVG maps lack real zoom/pan exploration.

- **Decision 3 — Tiered VTTS Smart Score Engine & Two-Stage Optimizer**:
  - *Chosen Approach*: Compute interactive Smart Score updates instantaneously on the client when toggling the 3-tier VTTS preset (`$5/hr`, `$15/hr`, `$35/hr`) or scrubbing the optional advanced slider, using phase-weighted pain multipliers (`0.4×` overnight sleeper, `1.0×` standard in-vehicle or short transfer `<2h`, `1.5×` normal layover `2–5h`, `2.5×` long layover `6+h`), while routing Two-Stage Route Optimization and Voucher Validation through dedicated Express `/api/*` endpoints.
  - *Why*: Realistic VTTS presets prevent unrealistic distortions on long-haul flights while rewarding sleeper trains and penalizing grueling 6+ hour airport layovers; client-side recalculation keeps preset/slider transitions instantaneous.

---

### 4. Technical Architecture & Data Strategy *(Technical Reference)*

- **Architecture & Component Diagram**:

```
┌───────────────────────────────────────────────────────────────────────────┐
│                         Top Navigation Bar (3 Zones)                      │
│   Astris Travel   │   Timeline · Smart Score · Vouchers   │ Optimize Route│
└───────────────────────────────────────────────────────────────────────────┘
                                      │
        ┌─────────────────────────────┴─────────────────────────────┐
        ▼                                                           ▼
┌───────────────────────────────────────┐ ┌─────────────────────────────────┐
│    Left Pane: Itinerary Workspace     │ │   Right Pane: MapLibre Canvas   │
│                                       │ │                                 │
│  ┌─────────────────────────────────┐  │ │  ┌───────────────────────────┐  │
│  │ Trip Summary & VTTS Tier Toggle │  │ │  │ Glassmorphic Filter Bar   │  │
│  │ ($5/$15/$35 + Advanced Slider)  │  │ │  │ [All|Flight|Train|Bus]    │  │
│  └─────────────────────────────────┘  │ │  └───────────────────────────┘  │
│                 │                     │ │                                 │
│                 ▼                     │ │  • Numbered Pins (1, 2, 3, 4)   │
│  ┌─────────────────────────────────┐  │ │  • @turf/great-circle Arcs      │
│  │ @dnd-kit Sortable Stop Timeline │◄─┼─┼─►• Hover & Active Leg Sync      │
│  │  • Stop Card (KUL, IST, LHR,PAR)│  │ │  • Interactive Camera FlyTo     │
│  │  • Expandable Leg Transit Cards │  │ └─────────────────────────────────┘
│  │  • Smart Score Breakdown        │  │
│  │  • Eligible Voucher Matcher     │  │
│  └─────────────────────────────────┘  │
└───────────────────┬───────────────────┘
                    │  GET /api/trips/default
                    │  POST /api/optimize-route (Stage 1 Geo + Stage 2 Transit)
                    │  POST /api/vouchers/validate
                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                Express API Server (Port 3000) & Shared Models             │
│                                                                           │
│  • Shared TypeScript Contracts + FastAPI / Pydantic v2 Reference Models   │
│  • Mock 4-Stop Dataset (Kuala Lumpur → Istanbul → London → Paris)         │
│  • Weighted VTTS Engine: discountedPrice + inVehicle*(rate*modeMult)       │
│    + layover*(rate*layoverMult) [0.4x sleeper, 1.0x/1.5x/2.5x layover]    │
│  • Two-Stage Route Optimizer & Voucher Eligibility Matcher                │
└───────────────────────────────────────────────────────────────────────────┘
```

- **Data Model & State**:
  - **`UserProfile` (`users` table)**: Holds `id`, `email`, `fullName`, `preferredCurrency`, and `timeValuePerHour` (`$15.00` default for Smart Score VTTS math).
  - **`Trip` (`trips` table)**: Holds `id`, `userId`, `title`, `startDate`, `endDate`, `currency`, `isRouteOptimized`, `vttsTier` (`'backpacker' | 'explorer' | 'express' | 'custom'`), `hourlyTimeValue` (`5`, `15` default, `35`, or custom slider value), ordered `stops`, and computed `legs`.
  - **`TripLeg` (`trip_legs` table)**: Represents the corridor between stop $N$ and stop $N+1$ (`id`, `tripId`, `orderIndex`, origin/destination city, code, `lat`/`lng`, `departureDate`, `nightsAtDestination`, `distanceKm`, `selectedOptionId`, `transitOptions`).
  - **`TransitOption` (`transit_options` table)**: Multi-modal candidate (`id`, `legId`, `mode` `'flight' | 'train' | 'bus' | 'ferry'`, `isOvernightSleeper`, `carrier`, `routeCode`, `originStation`, `destinationStation`, `departureTime`, `arrivalTime`, `inVehicleHours`, `layoverHours`, `stopsCount`, `basePriceUsd`, `discountedPriceUsd`, `smartScore`, `smartScoreBreakdown`, `bookingUrl`, `rawApiPayload`, `expiresAt`, `eligibleVoucherIds`).
  - **`Voucher` (`vouchers` table)**: Promo rule (`id`, `providerName`, `platformSource`, `code`, `title`, `discountType` `'percentage' | 'fixed'`, `discountValue`, `maxDiscountUsd`, `minSpendUsd`, `applicableModes`, `applicableCarriers`, `validFrom`, `expiresAt`, `isActive`, `description`).
  - **Shared Contracts & PostgreSQL DDL**: Identical schemas defined in TypeScript for client/Express runtime, mirrored in Python Pydantic v2 models, and backed by `SCHEMA.sql` with foreign key constraints and composite indexes (`idx_trip_legs_trip_order`, `idx_transit_options_leg_score`, `idx_vouchers_active_provider`) for future PostgreSQL persistence.

- **Interactive Component & State Mapping**:
  - *Stop Drag-and-Drop (`@dnd-kit/core` + `@dnd-kit/sortable`)*: Dropping a stop into a new position updates `stops` order, regenerates `TripLeg` pairs (`1→2`, `2→3`, `3→4`), fetches/computes corridor transit options, and updates MapLibre GeoJSON great-circle arcs immediately.
  - *Hover & Selection Sync*: Hovering or clicking a stop or leg updates `hoveredStopId` / `activeLegId`, highlighting the corresponding pin and geodesic arc on MapLibre and smoothly panning the viewport.
  - *Tiered VTTS Preset Toggle, Advanced Slider & Mode Filter Bar*: Selecting **Budget Backpacker (`$5/hr`)**, **Balanced Explorer (`$15/hr`)**, or **Time-Rich / Express (`$35/hr`)**, fine-tuning via the collapsible advanced slider, or toggling `activeModeFilter` recomputes every option's weighted `smartScore` (`discountedPrice + inVehicleHours * baseRate * (isOvernightSleeper ? 0.4 : 1.0) + layoverHours * baseRate * layoverMultiplier`) and re-sorts visible cards per leg.
  - *Route Optimizer Modal/Drawer*: Invokes `POST /api/optimize-route`, displaying Stage 1 candidate permutations ranked by total great-circle km alongside Stage 2 transit-cost & weighted Smart Score comparisons, with an **Apply Optimized Order** action.
  - *Voucher Toggle & Code Input*: Validates codes via `POST /api/vouchers/validate` or inline rule evaluation, updating discounted fare and net Smart Score across the leg and trip summary bar.
