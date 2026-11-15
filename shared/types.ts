export type TransitMode = 'flight' | 'train' | 'bus' | 'ferry';

export type ModeFilter = 'all' | TransitMode;

/** A leg is booked as a single one-way ticket or as a return ticket (there and back). */
export type TicketType = 'one-way' | 'return';

/** What the traveller chose for one leg. Absent = automatic (cheapest structure wins). */
export interface LegTicketPref {
  type: TicketType;
  /** Return date `YYYY-MM-DD`; defaults to the matching later leg or the day you leave. */
  returnDate?: string;
}

export type VttsTier = 'backpacker' | 'explorer' | 'express' | 'custom';

export interface UserProfile {
  id: string;
  email: string;
  fullName?: string;
  preferredCurrency: string;
  timeValuePerHour: number;
  createdAt?: string;
}

export interface VttsPreset {
  id: Exclude<VttsTier, 'custom'>;
  label: string;
  shortLabel: string;
  hourlyRateUsd: number;
  description: string;
}

/** Human-readable reasons an option was penalized; rendered as badges in the UI. */
export type ScoreFlag =
  | 'red-eye'
  | 'early-departure'
  | 'late-arrival'
  | 'long-layover'
  | 'overnight-layover'
  | 'multi-stop'
  | 'airport-change';

/**
 * Traveler preference weights applied on top of the hourly VTTS rate.
 * score = priceWeight * netPrice + timeWeight * (all time-based penalties)
 */
export interface TravelerProfile {
  /** Elasticity of cash cost. Higher = price-sensitive. Default 1.5. */
  priceWeight: number;
  /** Elasticity of time/comfort cost. Higher = time-sensitive. Default 1.0. */
  timeWeight: number;
  /** When true, time-of-day (red-eye / early / late) penalties are disabled. */
  allowRedEyes: boolean;
}

export interface SmartScoreBreakdown {
  basePriceUsd: number;
  discountAppliedUsd: number;
  discountedPriceUsd: number;
  hourlyRateUsd: number;
  inVehicleHours: number;
  modeMultiplier: number;
  inVehiclePenaltyUsd: number;
  layoverHours: number;
  /** Effective layover multiplier = layoverPenaltyUsd / (layoverHours * hourlyRateUsd). */
  layoverMultiplier: number;
  layoverPenaltyUsd: number;
  /** Combined departure x arrival convenience multiplier (1.0 = neutral). */
  timeOfDayMultiplier: number;
  /** Extra USD-equivalent cost from time-of-day inconvenience. */
  timeOfDayPenaltyUsd: number;
  /** Multi-stop connection friction. */
  transferPenaltyUsd: number;
  /** Friction when consecutive segments use different airports/stations. */
  airportChangePenaltyUsd: number;
  /** 2 for a return ticket: the time and comfort terms above are counted for both journeys. */
  journeys?: number;
  priceWeight: number;
  timeWeight: number;
  flags: ScoreFlag[];
  totalSmartScore: number;
}

export interface DestinationHub {
  id: string;
  city: string;
  country: string;
  iataCode: string;
  lat: number;
  lng: number;
  region: string;
  recommendedNights: number;
  tagline: string;
}

export interface TripStop {
  id: string;
  order: number;
  city: string;
  country: string;
  iataCode: string;
  lat: number;
  lng: number;
  stayNights: number;
  arrivalDate: string;
  departureDate: string;
  notes?: string;
}

export interface TransitSegment {
  id: string;
  mode: TransitMode;
  label: string;
  fromName: string;
  fromCode: string;
  fromLat: number;
  fromLng: number;
  toName: string;
  toCode: string;
  toLat: number;
  toLng: number;
  durationMinutes: number;
  /**
   * [lng, lat] stations/stops the ground leg calls at, endpoints included. The map smooths a curve
   * through them (`shared/groundRouting.ts`), so these are places, not polyline vertices.
   */
  waypoints?: [number, number][];
}

/** Merchants we deep-link to directly (no metasearch hop). */
export type BookingProvider = 'tripcom' | 'flixbus' | '12go' | 'booking' | 'agoda';

/** Merchants shown side by side in a flight's "Proceed to booking" comparison panel. */
export type OfferProviderId = 'tripcom' | 'kiwi' | 'skyscanner' | 'google-flights';

/**
 * One merchant's offer for a flight ticket. The price is per person in USD (the app converts it for
 * display). `estimated` is true when it is not a quote from that merchant: only the primary
 * merchant's offer carries the live fare, the others are derived from it and confirmed on their site.
 */
export interface AffiliateOffer {
  providerId: OfferProviderId;
  /** Display name, e.g. `Trip.com`. */
  provider: string;
  /** Key of the merchant badge the UI draws (same as `providerId`). */
  logo: OfferProviderId;
  priceUsd: number;
  /** Deep link to that merchant's results for this exact route and date. */
  url: string;
  estimated: boolean;
}

/** Whether a bag comes with the fare. `unknown` = the provider did not say. */
export type BagStatus = 'included' | 'fee' | 'none' | 'unknown';

/** Baggage allowance for a ticket. */
export interface BaggageInfo {
  cabin: BagStatus;
  checked: BagStatus;
  cabinKg?: number;
  checkedPieces?: number;
  checkedKg?: number;
  /** `provider`: read from the fare data. `typical`: the carrier's usual economy policy; confirm when booking. */
  source: 'provider' | 'typical';
  note?: string;
}

/** Ranking tags: see `shared/ranking.ts`. */
export type OptionTag = 'cheapest' | 'cheapest-direct' | 'direct';

/** One flight on a live itinerary, exactly as the provider reported it. */
export interface FlightHop {
  flightNumber: string;
  airline: string;
  airlineLogo?: string;
  airplane?: string;
  travelClass?: string;
  fromCode: string;
  fromName: string;
  /** `YYYY-MM-DD HH:MM` local time */
  departureAt: string;
  toCode: string;
  toName: string;
  arrivalAt: string;
  durationMinutes: number;
}

export interface Layover {
  code: string;
  name: string;
  minutes: number;
  overnight?: boolean;
}

export interface TransitOption {
  id: string;
  legId?: string;
  mode: TransitMode;
  isOvernightSleeper: boolean;
  carrier: string;
  carrierCode: string;
  routeCode: string;
  originStation: string;
  destinationStation: string;
  departureTime: string;
  arrivalTime: string;
  inVehicleHours: number;
  layoverHours: number;
  layoverHub?: string;
  stopsCount: number;
  basePriceUsd: number;
  discountedPriceUsd: number;
  smartScore: number;
  smartScoreBreakdown: SmartScoreBreakdown;
  doorToDoorNotes: string;
  co2Kg: number;
  bookingUrl?: string;
  /** Merchant `bookingUrl` lands on. */
  bookingProvider?: BookingProvider;
  /**
   * `return` options are priced for the whole round trip (`basePriceUsd` is the total) and scored
   * on both journeys. Absent means one-way.
   */
  ticketType?: TicketType;
  /** Date of the way back, for `return` options. */
  returnDate?: string;
  /** Ground return tickets are two searches (merchants sell each direction); this is the way back. */
  returnBookingUrl?: string;
  /** Flights: the merchants that sell this ticket, with their prices and links (see AffiliateOffer). */
  offers?: AffiliateOffer[];
  baggage?: BaggageInfo;
  /** `Cheapest`, `Cheapest Direct` and `Direct` badges, set when the list is ranked. */
  tags?: OptionTag[];
  /** Every flight with its number, airline, aircraft and local times (live data, or derived for samples). */
  hops?: FlightHop[];
  layovers?: Layover[];
  airlineLogo?: string;
  /**
   * Where this option's data came from. Only `live` is a real, current fare; `curated` and
   * `synthesized` are sample/estimated data and the UI labels them as such.
   */
  dataSource?: 'live' | 'curated' | 'synthesized';
  /** Every flight number on the itinerary, in order (live data), e.g. ["PC 123", "PC 456"]. */
  flightNumbers?: string[];
  /** Distinct operating airlines in order of first appearance (live data). */
  carriers?: string[];
  /** Raw provider timestamps ("YYYY-MM-DD HH:MM") for the first departure / last arrival. */
  departureAt?: string;
  arrivalAt?: string;
  expiresAt?: string;
  eligibleVoucherIds: string[];
  appliedVoucherId?: string | null;
  segments?: TransitSegment[];
}

/** One-way tickets vs a return ticket for a pair of legs that go there and back. */
export interface FareComparison {
  /** `live`: all three prices are real fares. `estimate`: not decisive, never auto-selected. */
  basis: 'live' | 'estimate';
  /** The later leg that comes back (a return ticket covers it). */
  pairedLegId: string;
  /** This leg's cheapest one-way plus the paired leg's cheapest one-way. */
  oneWayTotalUsd: number;
  returnTotalUsd: number;
  cheaper: 'one-way' | 'return' | 'tie';
  savingsUsd: number;
}

export interface TripLeg {
  id: string;
  fromStopId: string;
  toStopId: string;
  fromCity: string;
  fromCode: string;
  toCity: string;
  toCode: string;
  distanceKm: number;
  selectedOptionId: string;
  /** The options for the current `ticketType`: what the card lists and the map draws. */
  transitOptions: TransitOption[];
  /** Departure date of this leg (`YYYY-MM-DD`). */
  departureDate?: string;
  /** Both ticket structures, kept side by side so switching is instant and comparable. */
  oneWayOptions?: TransitOption[];
  returnOptions?: TransitOption[];
  ticketType?: TicketType;
  /** True when the traveller chose the type; false when the cheaper fare was picked for them. */
  ticketLocked?: boolean;
  returnDate?: string;
  /** Later leg that comes back to where this one started (a return here covers it). */
  pairedLegId?: string;
  /** This leg is already paid for by the return ticket on another leg. */
  coveredByLegId?: string;
  fareComparison?: FareComparison;
  /** Identity of the fare search (date, route, travellers); equal keys can reuse live fares. */
  fareKey?: string;
}

export interface Voucher {
  id: string;
  code: string;
  providerName?: string;
  platformSource?: string;
  title: string;
  discountType: 'percentage' | 'fixed';
  discountValue: number;
  maxDiscountUsd?: number;
  minSpendUsd: number;
  applicableModes: TransitMode[];
  applicableCarriers?: string[];
  validFrom?: string;
  expiresAt: string;
  isActive?: boolean;
  description: string;
}

export interface Trip {
  id: string;
  userId?: string;
  title: string;
  startDate?: string;
  endDate?: string;
  travelers: number;
  currency: 'USD';
  isRouteOptimized?: boolean;
  vttsTier: VttsTier;
  hourlyTimeValue: number;
  travelerProfile?: Partial<TravelerProfile>;
  stops: TripStop[];
  legs: TripLeg[];
  appliedVoucherCodes: string[];
  /** Ticket choices the traveller made, by leg id. */
  legPrefs?: Record<string, LegTicketPref>;
}

export interface OptimizationCandidate {
  stopIds: string[];
  routeLabels: string[];
  totalDistanceKm: number;
  estimatedTotalCostUsd: number;
  estimatedTotalHours: number;
  totalSmartScore: number;
  stage1Rank: number;
}

export interface RouteOptimizationResult {
  originalDistanceKm: number;
  optimizedDistanceKm: number;
  distanceSavedKm: number;
  originalCostUsd: number;
  optimizedCostUsd: number;
  originalSmartScore: number;
  optimizedSmartScore: number;
  optimizedStops: TripStop[];
  optimizedLegs: TripLeg[];
  candidatesEvaluated: number;
  topCandidates: OptimizationCandidate[];
  alreadyOptimal: boolean;
  summaryMessage: string;
}

export interface VoucherValidationResult {
  valid: boolean;
  voucher?: Voucher;
  reason?: string;
  eligibleLegIds: string[];
  estimatedSavingsUsd: number;
}

// ── Stays (hotel layer) ─────────────────────────────────────────────────────────────────────────

export type StayCategory = 'hostel' | 'budget' | 'midrange' | 'apartment' | 'upscale' | 'luxury';

/** Same shape of idea as `SmartScoreBreakdown`: every term in USD, lower total is better. */
export interface StayScoreBreakdown {
  nights: number;
  adults: number;
  nightlyPriceUsd: number;
  totalPriceUsd: number;
  hourlyRateUsd: number;
  /** Door-to-centre time, one way. */
  commuteMinutesOneWay: number;
  commuteHours: number;
  commutePenaltyUsd: number;
  /** Share of the hours spent at the property that counts as lost comfort (0 = none). */
  comfortMultiplier: number;
  comfortPenaltyUsd: number;
  priceWeight: number;
  timeWeight: number;
  totalSmartScore: number;
}

export interface StayLink {
  provider: Extract<BookingProvider, 'booking' | 'agoda'>;
  providerName: string;
  url: string;
}

/** A category of accommodation for one stop. Prices are estimates, never live rates. */
export interface StayOption {
  id: string;
  stopId: string;
  category: StayCategory;
  title: string;
  description: string;
  /** Hotel star class used for the partner filter, when the category has one. */
  starClass?: number;
  /** Whole party, per night. */
  nightlyPriceUsd: number;
  totalPriceUsd: number;
  commuteMinutesOneWay: number;
  smartScore: number;
  smartScoreBreakdown: StayScoreBreakdown;
  dataSource: 'synthesized';
  links: StayLink[];
}

/** Everything the "Staying in [City]?" card needs for one stop. */
export interface StaySearch {
  stopId: string;
  stopIndex: number;
  city: string;
  country: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  rooms: number;
  /** Unfiltered city + dates search on each partner. */
  links: StayLink[];
  /** Ranked by Smart Score, best first. */
  options: StayOption[];
}
