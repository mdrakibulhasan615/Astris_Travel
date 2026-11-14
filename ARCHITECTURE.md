# Astris Travel — Master System & Architecture Context

## 1. Project Overview & Core Philosophy
**Astris Travel** is a global, high-performance travel discovery and booking SaaS. Unlike traditional OTAs that overwhelm users with raw listings, Astris ranks multi-modal routes using **VTTS (Value of Travel Time Savings)** tailored to a user's chosen travel pacing, pairs routes with real-time promo code valuation, and maps exact airport-to-airport transit paths cleanly.

---

## 2. Tech Stack & Infrastructure
- **Frontend:** React, TypeScript, Vite, Tailwind CSS
- **Backend:** Node.js, Express / TypeScript (`server.ts`)
- **Caching Layer:** Upstash Redis (`@upstash/redis`, HTTP/REST SDK) — 12-hour (`43200s`) TTL on transit search responses to preserve API quota and deliver sub-50ms repeat lookups.
- **Environment Variables (`.env.local`):**
  - `SERPAPI_KEY` — Live Google Flights search provider (`google_flights` engine)
  - `UPSTASH_REDIS_REST_URL` & `UPSTASH_REDIS_REST_TOKEN` — Serverless Redis cache credentials
  - `DUFFEL_ACCESS_TOKEN` *(Phase 2)* — Live flight offer pricing & order creation

---

## 3. External Services & Data Pipelines

| Layer | Provider / Package | Technical Implementation & Role |
| :--- | :--- | :--- |
| **Live Flight Discovery** | **SerpApi** (`engine=google_flights`) | Fetches live flight schedules, segments, carrier codes, emissions, and base prices via 3-letter IATA `departure_id` and `arrival_id` parameters. |
| **Global Airport Data** | **`airports`** (npm dataset) | Local lightweight dataset providing global airport search (city, airport name, 3-letter IATA) and **exact tarmac latitude/longitude coordinates**. |
| **Vouchers & Discounts** | **`voucherService.ts` + `VOUCHERS_CATALOG`** | Internal coupon validation engine supporting percentage discounts, fixed cash reductions, and max discount caps (e.g., `ASTRIS15`). Feeds net prices directly into the Smart Score calculation. |
| **Ticket Fulfillment** | **Duffel API** (`@duffel/api`) *(Phase 2)* | NDC-first flights API for real-time offer requests (`POST /air/offer_requests`), single-offer pricing (`GET /air/offers/{id}`), ancillaries, and live order issuance (`POST /air/orders`). |
| **Affiliate Monetization** | **Travelpayouts / Deep Links** *(MVP)* | Wraps outbound booking CTAs with partner deep links (CPA/CPC revenue share) before full Duffel native checkout is enabled. |

---

## 4. Core File Architecture
```text
├── server.ts                  # Express backend entry, API routes, Redis cache middleware
├── src/
│   ├── services/
│   │   ├── transitService.ts  # SerpApi Google Flights integration, coordinate resolution, leg builder
│   │   └── voucherService.ts  # Promo code validation, discount math, VOUCHERS_CATALOG
│   ├── components/
│   │   ├── TripPlanner.tsx    # Main search, itinerary list, pacing slider, and voucher input UI
│   │   ├── RouteMap.tsx       # Interactive map rendering flight arcs & transit segments
│   │   └── AirportSearch.tsx  # Global autocomplete input backed by `airports` dataset
└── shared/
    └── smartScore.ts          # VTTS composite scoring engine & layover penalty math