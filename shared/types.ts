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

export interface SmartScoreBreakdown {
  basePriceUsd: number;
  discountAppliedUsd: number;
  discountedPriceUsd: number;
  hourlyRateUsd: number;
  inVehicleHours: number;
  modeMultiplier: number;
  inVehiclePenaltyUsd: number;
  layoverHours: number;
  layoverMultiplier: number;
  layoverPenaltyUsd: number;
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
  waypoints?: [number, number][]; // [lng, lat] intermediate stations/stops for ground polylines
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
