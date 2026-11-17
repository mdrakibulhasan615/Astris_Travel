import type { PriceBreakdown } from './pricing.ts';

/**
 * The shapes the flight search and checkout API speak. They are what the browser sees: Duffel's own
 * payload is normalised into these on the server, and prices already carry our service fee.
 */

export type CabinClass = 'economy' | 'premium_economy' | 'business' | 'first';

export interface SliceRequest {
  /** City or airport IATA code. */
  origin: string;
  destination: string;
  /** `YYYY-MM-DD` */
  departureDate: string;
}

export interface FlightSearchRequest {
  /** One slice = one-way, two = round trip, more = multi-city. */
  slices: SliceRequest[];
  passengers: number;
  cabinClass?: CabinClass;
}

export interface AirportRefDto {
  iataCode: string;
  name: string;
  city?: string;
}

export interface CarrierDto {
  name: string;
  iataCode: string;
  logoUrl?: string;
}

export interface FlightSegmentDto {
  /** Marketing flight number, e.g. `EY 411`. */
  flightNumber: string;
  carrier: CarrierDto;
  /** Present when another airline operates the flight. */
  operatingCarrier?: CarrierDto;
  origin: AirportRefDto;
  destination: AirportRefDto;
  /** Local time, ISO without offset (`2026-11-21T19:45:00`). */
  departureAt: string;
  arrivalAt: string;
  durationMinutes: number;
  aircraft?: string;
}

export interface LayoverDto {
  airport: AirportRefDto;
  minutes: number;
  overnight: boolean;
}

export interface FlightSliceDto {
  origin: AirportRefDto;
  destination: AirportRefDto;
  departureAt: string;
  arrivalAt: string;
  durationMinutes: number;
  segments: FlightSegmentDto[];
  layovers: LayoverDto[];
}

/** A bookable fare from Duffel, priced for the whole party. */
export interface DuffelOfferDto {
  source: 'duffel';
  /** Duffel's offer id (`off_0000…`). Valid only until `expiresAt`. */
  offerId: string;
  /** ISO timestamp (UTC) after which the offer can no longer be booked. */
  expiresAt: string;
  owner: CarrierDto;
  cabinClass?: CabinClass;
  passengers: number;
  slices: FlightSliceDto[];
  pricing: PriceBreakdown;
}

/** A fare on an airline Duffel does not sell (AirAsia, Ryanair…): handed off to a partner link. */
export interface UlccFallbackDto {
  source: 'external_ulcc';
  carrier: CarrierDto;
  /** Partner link to the airline's fare; opens in a new tab. No checkout call is involved. */
  affiliateUrl: string;
  /** The recent fare, in USD, when the data source had one. */
  priceUsd?: number;
  slices: Pick<FlightSliceDto, 'origin' | 'destination' | 'departureAt'>[];
}

export interface FlightSearchResponse {
  offers: DuffelOfferDto[];
  ulcc: UlccFallbackDto[];
  /** True when the offers came from the 10-minute offer cache. */
  cached: boolean;
}

// ── Checkout ─────────────────────────────────────────────────────────────────────────────────────

export interface CheckoutRequest {
  offerId: string;
  slices: SliceRequest[];
  passengers: number;
  cabinClass?: CabinClass;
  /** The `displayTotal` the traveller saw; the server refuses to continue if the live price differs. */
  expectedTotal: number;
  currency: string;
}

export type CheckoutErrorCode =
  | 'bad_request'
  | 'offer_expired'
  | 'price_changed'
  | 'not_configured'
  | 'upstream_error';

export interface CheckoutResponse {
  checkoutUrl: string;
  reference: string;
}

export interface CheckoutErrorResponse {
  error: CheckoutErrorCode;
  message: string;
  /** For `price_changed`: the price the live offer now has. */
  pricing?: PriceBreakdown;
}
