export type TransitMode = 'flight' | 'train' | 'bus' | 'ferry';

export type ModeFilter = 'all' | TransitMode;

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
  transitOptions: TransitOption[];
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
