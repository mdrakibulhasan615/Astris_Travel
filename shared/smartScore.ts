import type {
  ScoreFlag,
  SmartScoreBreakdown,
  TransitMode,
  TransitOption,
  TransitSegment,
  TravelerProfile,
  TripLeg,
  TripStop,
  Voucher,
  VttsPreset,
} from './types.ts';
import { attachBookingUrls } from './affiliate.ts';

export const VTTS_PRESETS: VttsPreset[] = [
  {
    id: 'backpacker',
    label: 'Budget Backpacker',
    shortLabel: 'Backpacker',
    hourlyRateUsd: 5,
    description: 'Maximizes cash savings; tolerant of longer transit and transfers.',
  },
  {
    id: 'explorer',
    label: 'Balanced Explorer',
    shortLabel: 'Balanced',
    hourlyRateUsd: 15,
    description: 'Balanced trade-off between ticket fare and comfortable travel hours.',
  },
  {
    id: 'express',
    label: 'Express',
    shortLabel: 'Express',
    hourlyRateUsd: 35,
    description: 'Prioritizes direct corridors and heavily penalizes long layovers.',
  },
];

/**
 * Maps a visual travel pacing percentage (0% to 100%) to an hourly time value ($/hr).
 * - 0% corresponds to Budget Backpacker ($5/hr)
 * - 50% corresponds to Balanced Explorer ($15/hr)
 * - 100% corresponds to Express ($35/hr)
 */
export function pacingPercentToHourlyRate(percent: number): number {
  const p = Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 50;
  if (p <= 50) {
    // 0% -> $5/hr, 50% -> $15/hr (+$0.20 per 1%)
    return round2(5 + (p / 50) * 10);
  }
  // 50% -> $15/hr, 100% -> $35/hr (+$0.40 per 1%)
  return round2(15 + ((p - 50) / 50) * 20);
}

/**
 * Maps an hourly time value ($/hr) back to a visual travel pacing percentage (0% to 100%).
 */
export function hourlyRateToPacingPercent(hourlyRate: number): number {
  if (hourlyRate <= 5) return 0;
  if (hourlyRate <= 15) {
    return Math.round(((hourlyRate - 5) / 10) * 50);
  }
  if (hourlyRate >= 35) return 100;
  return Math.round(50 + ((hourlyRate - 15) / 20) * 50);
}

export function getModeMultiplier(isOvernightSleeper: boolean): number {
  return isOvernightSleeper ? 0.4 : 1.0;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Normalizes a caller-supplied $/hr time value. Non-numeric, NaN, or negative input
 * (e.g. `?hourlyRate=abc`) would otherwise poison every score with NaN and break sorting.
 */
export function sanitizeHourlyRate(value: unknown, fallback: number = 15): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * A voucher is usable when it is not explicitly deactivated and `now` falls inside
 * [validFrom, expiresAt]. Dates are ISO `YYYY-MM-DD`; expiry is inclusive of that whole day (UTC).
 */
export function isVoucherCurrentlyValid(voucher: Voucher, now: Date = new Date()): boolean {
  if (voucher.isActive === false) return false;
  const today = now.toISOString().slice(0, 10);
  if (voucher.validFrom && today < voucher.validFrom.slice(0, 10)) return false;
  if (voucher.expiresAt && today > voucher.expiresAt.slice(0, 10)) return false;
  return true;
}

function voucherAppliesToCarrier(voucher: Voucher, carrierCode: string): boolean {
  return (
    !voucher.applicableCarriers ||
    voucher.applicableCarriers.length === 0 ||
    voucher.applicableCarriers.includes(carrierCode)
  );
}

export function calculateVoucherDiscount(
  option: Pick<TransitOption, 'basePriceUsd' | 'mode' | 'carrierCode' | 'eligibleVoucherIds'>,
  voucher: Voucher | null | undefined
): number {
  if (!voucher) return 0;
  if (!isVoucherCurrentlyValid(voucher)) return 0;
  if (!voucher.applicableModes.includes(option.mode)) return 0;
  if (option.basePriceUsd < voucher.minSpendUsd) return 0;
  if (!voucherAppliesToCarrier(voucher, option.carrierCode)) return 0;

  let discount =
    voucher.discountType === 'percentage'
      ? (option.basePriceUsd * voucher.discountValue) / 100
      : voucher.discountValue;

  if (voucher.maxDiscountUsd !== undefined) {
    discount = Math.min(discount, voucher.maxDiscountUsd);
  }

  return round2(Math.min(discount, option.basePriceUsd));
}

// ─────────────────────────────────────────────────────────────────────────────
// Smart Score (VTTS) engine
//
//   score = priceWeight × netPrice
//         + timeWeight  × ( inVehicle + layover + timeOfDay + transfer + airportChange )
//
// All time-based terms are expressed in USD via the traveler's hourly rate (VTTS), so a lower
// score is always better. Every heuristic below is O(1) per option (no allocations beyond the
// small flags array), so re-scoring a few hundred options on each slider tick stays cheap.
// ─────────────────────────────────────────────────────────────────────────────

/** Defaults reproduce the original 1.5× price sensitivity with neutral time weighting. */
export const DEFAULT_TRAVELER_PROFILE: TravelerProfile = {
  priceWeight: 1.5,
  timeWeight: 1.0,
  allowRedEyes: false,
};

function clampWeight(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(5, Math.max(0.1, n));
}

/** Merges a partial profile over the defaults and clamps weights to a sane [0.1, 5] range. */
export function resolveTravelerProfile(profile?: Partial<TravelerProfile> | null): TravelerProfile {
  if (!profile) return DEFAULT_TRAVELER_PROFILE;
  return {
    priceWeight: clampWeight(profile.priceWeight, DEFAULT_TRAVELER_PROFILE.priceWeight),
    timeWeight: clampWeight(profile.timeWeight, DEFAULT_TRAVELER_PROFILE.timeWeight),
    allowRedEyes: profile.allowRedEyes ?? DEFAULT_TRAVELER_PROFILE.allowRedEyes,
  };
}

/**
 * Convenience mapping from a 0–1 time-sensitivity slider to weights.
 * 0 = purely price-driven (2.25× price, 0.5× time), 0.5 = defaults, 1 = purely time-driven.
 */
export function profileFromTimeSensitivity(
  sensitivity: number,
  allowRedEyes = false
): TravelerProfile {
  const s = Number.isFinite(sensitivity) ? Math.min(1, Math.max(0, sensitivity)) : 0.5;
  return {
    priceWeight: round2(1.5 * (1.5 - s)),
    timeWeight: round2(0.5 + s),
    allowRedEyes,
  };
}

/**
 * Non-linear layover cost in "effective hours" (multiplied by the hourly rate):
 *  - < 2h   : minimal baseline, 0.25 effective h per hour (a short connection is cheap).
 *  - 2–4h   : scales linearly, 1.0 effective h per hour on top of the 2h baseline (0.5h).
 *  - > 4h   : fatigue kicks in — linear 1.0/h plus an exponential term 0.5·(e^{0.4·Δ} − 1)
 *             where Δ = hours beyond 4. Δ is capped at 12h so a 40h "layover" cannot overflow.
 * Continuous at the 2h and 4h boundaries. Values: 1h→0.25, 3h→1.5, 4h→2.5, 6h→5.1, 10h→13.5.
 */
export function layoverEffectiveHours(layoverHours: number): number {
  const h = Number.isFinite(layoverHours) ? Math.max(0, layoverHours) : 0;
  if (h <= 0) return 0;
  if (h <= 2) return 0.25 * h;
  if (h <= 4) return 0.5 + (h - 2);
  const excess = Math.min(h - 4, 12);
  return 2.5 + excess + 0.5 * (Math.exp(0.4 * excess) - 1) + Math.max(0, h - 16);
}

/** Parses "HH:MM" (optionally followed by " +1d") into fractional hours, or null if malformed. */
function parseClockHour(time: string | undefined): number | null {
  if (!time) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h + min / 60;
}

/**
 * Departure-hour convenience multiplier.
 *   00:00–04:59 red-eye 1.25 · 05:00–05:59 very early 1.15 · 06:00–06:59 early 1.05
 *   22:00–23:59 late 1.08 · otherwise 1.0
 */
function departureMultiplier(hour: number): { mult: number; flag?: ScoreFlag } {
  if (hour < 5) return { mult: 1.25, flag: 'red-eye' };
  if (hour < 6) return { mult: 1.15, flag: 'early-departure' };
  if (hour < 7) return { mult: 1.05 };
  if (hour >= 22) return { mult: 1.08 };
  return { mult: 1.0 };
}

/**
 * Arrival-hour convenience multiplier: landing between 00:00 and 05:59 means no onward transit
 * and a hotel that may not be available (1.2×); 22:00–23:59 is mildly inconvenient (1.08×).
 */
function arrivalMultiplier(hour: number): { mult: number; flag?: ScoreFlag } {
  if (hour < 6) return { mult: 1.2, flag: 'late-arrival' };
  if (hour >= 22) return { mult: 1.08 };
  return { mult: 1.0 };
}

/**
 * True when the layover window [start, start + hours) overlaps the 23:00–05:00 overnight window.
 * Layover start is estimated as departure + in-vehicle time split evenly across the legs.
 */
function layoverCrossesNight(
  departureHour: number | null,
  inVehicleHours: number,
  stopsCount: number,
  layoverHours: number
): boolean {
  if (departureHour === null || layoverHours <= 0) return false;
  const start = departureHour + inVehicleHours / (Math.max(0, stopsCount) + 1);
  const end = start + Math.min(layoverHours, 24);
  // Overnight windows on an absolute timeline: [24d − 1, 24d + 5) for d = 0..3
  for (let d = Math.floor(start / 24); d <= Math.floor(end / 24) + 1; d++) {
    if (start < 24 * d + 5 && end > 24 * d - 1) return true;
  }
  return false;
}

/**
 * Detects a change of airport/station between consecutive segments (e.g. arrive IST, depart SAW
 * in the same metro). Contiguous itineraries have `prev.toCode === next.fromCode`.
 */
export function detectAirportChange(segments: TransitSegment[] | undefined): boolean {
  if (!segments || segments.length < 2) return false;
  for (let i = 1; i < segments.length; i++) {
    const arrives = segments[i - 1].toCode;
    const departs = segments[i].fromCode;
    if (arrives && departs && arrives !== departs) return true;
  }
  return false;
}

/** Fields the engine reads; the time-of-day / transfer inputs are optional for partial callers. */
export type ScorableOption = Pick<
  TransitOption,
  | 'basePriceUsd'
  | 'inVehicleHours'
  | 'layoverHours'
  | 'isOvernightSleeper'
  | 'mode'
  | 'carrierCode'
  | 'eligibleVoucherIds'
> &
  Partial<Pick<TransitOption, 'departureTime' | 'arrivalTime' | 'stopsCount' | 'segments'>>;

const STOP_FRICTION_HOURS = 0.75; // per connection, +25% for each additional one
const MIN_STOP_FRICTION_USD = 8; // floor so low-rate backpackers still feel connections
const AIRPORT_CHANGE_HOURS = 2.5; // transfer between airports + re-check-in
const MIN_AIRPORT_CHANGE_USD = 25;
const TIGHT_AIRPORT_CHANGE_LAYOVER_H = 4; // <4h across two airports risks a missed connection
const OVERNIGHT_LAYOVER_SURCHARGE_HOURS = 1.5;
const MAX_TIME_OF_DAY_MULTIPLIER = 1.6;

export function computeSmartScore(
  option: ScorableOption,
  rawHourlyRateUsd: number,
  bestVoucher?: Voucher | null,
  profileInput?: Partial<TravelerProfile> | null
): SmartScoreBreakdown {
  const hourlyRateUsd = sanitizeHourlyRate(rawHourlyRateUsd);
  const profile = resolveTravelerProfile(profileInput);
  const flags: ScoreFlag[] = [];

  const discountAppliedUsd = calculateVoucherDiscount(option, bestVoucher);
  const discountedPriceUsd = round2(Math.max(0, option.basePriceUsd - discountAppliedUsd));

  const layoverHours = Number.isFinite(option.layoverHours) ? Math.max(0, option.layoverHours) : 0;
  const stopsCount = Math.max(0, option.stopsCount ?? 0);
  const depHour = parseClockHour(option.departureTime);
  const arrHour = parseClockHour(option.arrivalTime);

  // 1. In-vehicle time (sleepers are discounted: you are asleep, not "lost")
  const modeMultiplier = getModeMultiplier(option.isOvernightSleeper);
  const inVehiclePenaltyUsd = round2(option.inVehicleHours * hourlyRateUsd * modeMultiplier);

  // 2. Non-linear layover penalty (+ overnight fatigue surcharge beyond 4h)
  let layoverEffHours = layoverEffectiveHours(layoverHours);
  if (layoverHours > 4) {
    flags.push('long-layover');
    if (layoverCrossesNight(depHour, option.inVehicleHours, stopsCount, layoverHours)) {
      flags.push('overnight-layover');
      layoverEffHours += OVERNIGHT_LAYOVER_SURCHARGE_HOURS;
    }
  }
  const layoverPenaltyUsd = round2(layoverEffHours * hourlyRateUsd);
  const layoverMultiplier =
    layoverHours > 0 && hourlyRateUsd > 0
      ? round2(layoverPenaltyUsd / (layoverHours * hourlyRateUsd))
      : 0;

  // 3. Time-of-day convenience. Sleepers are designed for night travel, and travelers can opt out.
  let timeOfDayMultiplier = 1;
  if (!profile.allowRedEyes && !option.isOvernightSleeper) {
    const dep = depHour === null ? { mult: 1 } : departureMultiplier(depHour);
    const arr = arrHour === null ? { mult: 1 } : arrivalMultiplier(arrHour);
    timeOfDayMultiplier = Math.min(MAX_TIME_OF_DAY_MULTIPLIER, dep.mult * arr.mult);
    if ('flag' in dep && dep.flag) flags.push(dep.flag);
    if ('flag' in arr && arr.flag) flags.push(arr.flag);
  }
  const timeOfDayPenaltyUsd = round2((timeOfDayMultiplier - 1) * (inVehiclePenaltyUsd + layoverPenaltyUsd));

  // 4. Transfer complexity: each extra connection adds friction, escalating 25% per stop
  let transferPenaltyUsd = 0;
  if (stopsCount > 0) {
    flags.push('multi-stop');
    const frictionHours = STOP_FRICTION_HOURS * (stopsCount + 0.25 * (stopsCount * (stopsCount - 1)) / 2);
    transferPenaltyUsd = round2(Math.max(frictionHours * hourlyRateUsd, stopsCount * MIN_STOP_FRICTION_USD));
  }

  // 5. Airport/station change between consecutive segments; riskier on tight connections
  let airportChangePenaltyUsd = 0;
  if (detectAirportChange(option.segments)) {
    flags.push('airport-change');
    const tight = layoverHours > 0 && layoverHours < TIGHT_AIRPORT_CHANGE_LAYOVER_H ? 1.5 : 1;
    airportChangePenaltyUsd = round2(
      Math.max(AIRPORT_CHANGE_HOURS * hourlyRateUsd, MIN_AIRPORT_CHANGE_USD) * tight
    );
  }

  // 6. Traveler weighting: price-sensitive vs time-sensitive elasticity
  const timeCostUsd =
    inVehiclePenaltyUsd +
    layoverPenaltyUsd +
    timeOfDayPenaltyUsd +
    transferPenaltyUsd +
    airportChangePenaltyUsd;
  const totalSmartScore = round2(
    discountedPriceUsd * profile.priceWeight + timeCostUsd * profile.timeWeight
  );

  return {
    basePriceUsd: option.basePriceUsd,
    discountAppliedUsd,
    discountedPriceUsd,
    hourlyRateUsd,
    inVehicleHours: option.inVehicleHours,
    modeMultiplier,
    inVehiclePenaltyUsd,
    layoverHours,
    layoverMultiplier,
    layoverPenaltyUsd,
    timeOfDayMultiplier: round2(timeOfDayMultiplier),
    timeOfDayPenaltyUsd,
    transferPenaltyUsd,
    airportChangePenaltyUsd,
    priceWeight: profile.priceWeight,
    timeWeight: profile.timeWeight,
    flags,
    totalSmartScore,
  };
}

export function pickBestActiveVoucher(
  option: Pick<TransitOption, 'basePriceUsd' | 'mode' | 'carrierCode' | 'eligibleVoucherIds'>,
  activeVouchers: Voucher[]
): { voucher: Voucher | null; discountUsd: number } {
  let bestVoucher: Voucher | null = null;
  let bestDiscount = 0;

  for (const voucher of activeVouchers) {
    const discount = calculateVoucherDiscount(option, voucher);
    if (discount > bestDiscount) {
      bestDiscount = discount;
      bestVoucher = voucher;
    }
  }

  return { voucher: bestVoucher, discountUsd: bestDiscount };
}

export function recalculateOptionsWithVttsAndVouchers(
  options: TransitOption[],
  hourlyRateUsd: number,
  activeVouchers: Voucher[],
  profile?: Partial<TravelerProfile> | null
): TransitOption[] {
  return options
    .map((option) => {
      const { voucher } = pickBestActiveVoucher(option, activeVouchers);
      const breakdown = computeSmartScore(option, hourlyRateUsd, voucher, profile);
      return {
        ...option,
        discountedPriceUsd: breakdown.discountedPriceUsd,
        smartScore: breakdown.totalSmartScore,
        smartScoreBreakdown: breakdown,
        appliedVoucherId: voucher ? voucher.id : null,
      };
    })
    .sort((a, b) => a.smartScore - b.smartScore);
}

export function haversineDistanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

/**
 * Generates realistic multi-modal corridor options when users reorder stops or add new destinations
 * that do not have a pre-authored static corridor entry.
 */
export function synthesizeCorridorOptions(
  fromStop: TripStop,
  toStop: TripStop,
  legId: string,
  allVouchers: Voucher[],
  hourlyRateUsd: number,
  activeVouchers: Voucher[],
  profile?: Partial<TravelerProfile> | null
): TransitOption[] {
  const distanceKm = Math.max(120, haversineDistanceKm(fromStop.lat, fromStop.lng, toStop.lat, toStop.lng));
  const options: TransitOption[] = [];

  // 1. Direct or fast flight
  const directFlightHours = round2(1.1 + distanceKm / 810);
  const directFlightPrice = Math.round(78 + distanceKm * 0.056);
  const fromAirportLat = fromStop.lat - 0.14;
  const fromAirportLng = fromStop.lng + 0.12;
  const toAirportLat = toStop.lat + 0.12;
  const toAirportLng = toStop.lng - 0.14;
  options.push(
    buildRawOption(
      {
        id: `${legId}-flt-direct`,
        legId,
        mode: 'flight',
        isOvernightSleeper: false,
        carrier: distanceKm > 3500 ? 'Turkish Airlines' : 'Astris Skyways',
        carrierCode: distanceKm > 3500 ? 'TK' : 'AS',
        routeCode: `${distanceKm > 3500 ? 'TK' : 'AS'} ${110 + (distanceKm % 780)}`,
        originStation: `${fromStop.iataCode} Intl Airport`,
        destinationStation: `${toStop.iataCode} Intl Airport`,
        departureTime: '09:40',
        arrivalTime: formatArrivalFromHours(9.67 + directFlightHours),
        inVehicleHours: directFlightHours,
        layoverHours: 0,
        stopsCount: 0,
        basePriceUsd: directFlightPrice,
        doorToDoorNotes: `${fromStop.city} Rail → ${fromStop.iataCode} → ${toStop.iataCode} → ${toStop.city} Metro`,
        co2Kg: Math.round(distanceKm * 0.115),
        segments: [
          {
            id: `${legId}-flt-direct-s1`,
            mode: 'train',
            label: `${fromStop.iataCode} Express`,
            fromName: fromStop.city,
            fromCode: fromStop.iataCode,
            fromLat: fromStop.lat,
            fromLng: fromStop.lng,
            toName: `${fromStop.iataCode} Airport`,
            toCode: fromStop.iataCode,
            toLat: fromAirportLat,
            toLng: fromAirportLng,
            durationMinutes: 25,
          },
          {
            id: `${legId}-flt-direct-s2`,
            mode: 'flight',
            label: `${distanceKm > 3500 ? 'TK' : 'AS'} ${110 + (distanceKm % 780)}`,
            fromName: `${fromStop.iataCode} Airport`,
            fromCode: fromStop.iataCode,
            fromLat: fromAirportLat,
            fromLng: fromAirportLng,
            toName: `${toStop.iataCode} Airport`,
            toCode: toStop.iataCode,
            toLat: toAirportLat,
            toLng: toAirportLng,
            durationMinutes: Math.round(directFlightHours * 60),
          },
          {
            id: `${legId}-flt-direct-s3`,
            mode: 'train',
            label: `${toStop.city} Rail`,
            fromName: `${toStop.iataCode} Airport`,
            fromCode: toStop.iataCode,
            fromLat: toAirportLat,
            fromLng: toAirportLng,
            toName: toStop.city,
            toCode: toStop.iataCode,
            toLat: toStop.lat,
            toLng: toStop.lng,
            durationMinutes: 30,
          },
        ],
      },
      allVouchers
    )
  );

  // 2. Value 1-stop connecting flight (longer corridors)
  if (distanceKm > 950) {
    const layoverHrs = distanceKm > 4500 ? 6.5 : 3.2;
    const oneStopHours = round2(directFlightHours + 1.2);
    const oneStopPrice = Math.round(directFlightPrice * 0.76);
    const midLat = (fromStop.lat + toStop.lat) / 2 + 2.5;
    const midLng = (fromStop.lng + toStop.lng) / 2 - 2.0;
    const hubCode = distanceKm > 4500 ? 'DOH' : 'SAW';
    options.push(
      buildRawOption(
        {
          id: `${legId}-flt-connect`,
          legId,
          mode: 'flight',
          isOvernightSleeper: false,
          carrier: 'Pegasus Connect',
          carrierCode: 'PC',
          routeCode: `PC ${302 + (distanceKm % 500)}`,
          originStation: `${fromStop.iataCode} Terminal 1`,
          destinationStation: `${toStop.iataCode} Terminal 2`,
          departureTime: '13:15',
          arrivalTime: formatArrivalFromHours(13.25 + oneStopHours + layoverHrs),
          inVehicleHours: oneStopHours,
          layoverHours: layoverHrs,
          layoverHub: hubCode,
          stopsCount: 1,
          basePriceUsd: oneStopPrice,
          doorToDoorNotes: `${fromStop.iataCode} → ${hubCode} (${layoverHrs}h) → ${toStop.iataCode}`,
          co2Kg: Math.round(distanceKm * 0.132),
          segments: [
            {
              id: `${legId}-flt-c-s1`,
              mode: 'flight',
              label: `PC Leg 1`,
              fromName: fromStop.city,
              fromCode: fromStop.iataCode,
              fromLat: fromStop.lat,
              fromLng: fromStop.lng,
              toName: hubCode,
              toCode: hubCode,
              toLat: midLat,
              toLng: midLng,
              durationMinutes: Math.round((oneStopHours * 60) / 2),
            },
            {
              id: `${legId}-flt-c-s2`,
              mode: 'flight',
              label: `PC Leg 2`,
              fromName: hubCode,
              fromCode: hubCode,
              fromLat: midLat,
              fromLng: midLng,
              toName: toStop.city,
              toCode: toStop.iataCode,
              toLat: toStop.lat,
              toLng: toStop.lng,
              durationMinutes: Math.round((oneStopHours * 60) / 2),
            },
          ],
        },
        allVouchers
      )
    );
  }

  // 3. Rail option (high-speed for <=2600km)
  if (distanceKm <= 2600) {
    const isSleeper = distanceKm > 750;
    const trainHours = round2(isSleeper ? 2.0 + distanceKm / 125 : 0.8 + distanceKm / 215);
    const trainPrice = Math.round(isSleeper ? 68 + distanceKm * 0.065 : 54 + distanceKm * 0.11);
    const wp1: [number, number] = [
      fromStop.lng + (toStop.lng - fromStop.lng) * 0.33 + 0.4,
      fromStop.lat + (toStop.lat - fromStop.lat) * 0.33 - 0.3,
    ];
    const wp2: [number, number] = [
      fromStop.lng + (toStop.lng - fromStop.lng) * 0.67 - 0.3,
      fromStop.lat + (toStop.lat - fromStop.lat) * 0.67 + 0.4,
    ];
    options.push(
      buildRawOption(
        {
          id: `${legId}-trn-rail`,
          legId,
          mode: 'train',
          isOvernightSleeper: isSleeper,
          carrier: isSleeper ? 'Nightjet Sleeper Rail' : 'EuroExpress Rail',
          carrierCode: isSleeper ? 'NJ' : 'EE',
          routeCode: `${isSleeper ? 'NJ' : 'EE'} ${400 + (distanceKm % 300)}`,
          originStation: `${fromStop.city} Central Station`,
          destinationStation: `${toStop.city} Central Station`,
          departureTime: isSleeper ? '21:15' : '10:30',
          arrivalTime: formatArrivalFromHours((isSleeper ? 21.25 : 10.5) + trainHours),
          inVehicleHours: trainHours,
          layoverHours: distanceKm > 1200 ? 1.4 : 0,
          stopsCount: distanceKm > 1200 ? 1 : 0,
          basePriceUsd: trainPrice,
          doorToDoorNotes: `${fromStop.city} Central → ${toStop.city} Central`,
          co2Kg: Math.round(distanceKm * 0.024),
          segments: [
            {
              id: `${legId}-trn-s1`,
              mode: 'train',
              label: isSleeper ? 'Nightjet' : 'EuroExpress',
              fromName: `${fromStop.city} Central`,
              fromCode: fromStop.iataCode,
              fromLat: fromStop.lat,
              fromLng: fromStop.lng,
              toName: `${toStop.city} Central`,
              toCode: toStop.iataCode,
              toLat: toStop.lat,
              toLng: toStop.lng,
              durationMinutes: Math.round(trainHours * 60),
              waypoints: [[fromStop.lng, fromStop.lat], wp1, wp2, [toStop.lng, toStop.lat]],
            },
          ],
        },
        allVouchers
      )
    );
  }

  // 4. Intercity bus option (for <=2200km)
  if (distanceKm <= 2200) {
    const isSleeperBus = distanceKm > 550;
    const busHours = round2(1.0 + distanceKm / 78);
    const busPrice = Math.round(24 + distanceKm * 0.036);
    const wp1: [number, number] = [
      fromStop.lng + (toStop.lng - fromStop.lng) * 0.35 - 0.5,
      fromStop.lat + (toStop.lat - fromStop.lat) * 0.35 + 0.25,
    ];
    const wp2: [number, number] = [
      fromStop.lng + (toStop.lng - fromStop.lng) * 0.7 + 0.35,
      fromStop.lat + (toStop.lat - fromStop.lat) * 0.7 - 0.3,
    ];
    options.push(
      buildRawOption(
        {
          id: `${legId}-bus-coach`,
          legId,
          mode: 'bus',
          isOvernightSleeper: isSleeperBus,
          carrier: 'FlixCoach Express',
          carrierCode: 'FX',
          routeCode: `FX ${800 + (distanceKm % 190)}`,
          originStation: `${fromStop.city} Coach Hub`,
          destinationStation: `${toStop.city} South Terminal`,
          departureTime: isSleeperBus ? '22:00' : '08:15',
          arrivalTime: formatArrivalFromHours((isSleeperBus ? 22 : 8.25) + busHours),
          inVehicleHours: busHours,
          layoverHours: distanceKm > 1100 ? 2.2 : 0,
          stopsCount: distanceKm > 1100 ? 1 : 0,
          basePriceUsd: busPrice,
          doorToDoorNotes: `${fromStop.city} Coach Hub → ${toStop.city} Terminal`,
          co2Kg: Math.round(distanceKm * 0.038),
          segments: [
            {
              id: `${legId}-bus-s1`,
              mode: 'bus',
              label: 'FlixCoach',
              fromName: `${fromStop.city} Coach Hub`,
              fromCode: fromStop.iataCode,
              fromLat: fromStop.lat,
              fromLng: fromStop.lng,
              toName: `${toStop.city} Terminal`,
              toCode: toStop.iataCode,
              toLat: toStop.lat,
              toLng: toStop.lng,
              durationMinutes: Math.round(busHours * 60),
              waypoints: [[fromStop.lng, fromStop.lat], wp1, wp2, [toStop.lng, toStop.lat]],
            },
          ],
        },
        allVouchers
      )
    );
  }

  return recalculateOptionsWithVttsAndVouchers(options, hourlyRateUsd, activeVouchers, profile);
}

function buildRawOption(
  partial: Omit<
    TransitOption,
    'discountedPriceUsd' | 'smartScore' | 'smartScoreBreakdown' | 'eligibleVoucherIds'
  >,
  allVouchers: Voucher[]
): TransitOption {
  const eligibleVoucherIds = allVouchers
    .filter(
      (v) =>
        v.applicableModes.includes(partial.mode) &&
        partial.basePriceUsd >= v.minSpendUsd &&
        voucherAppliesToCarrier(v, partial.carrierCode)
    )
    .map((v) => v.id);

  const placeholderBreakdown = computeSmartScore(
    {
      ...partial,
      eligibleVoucherIds,
    },
    15,
    null
  );

  return {
    ...partial,
    discountedPriceUsd: partial.basePriceUsd,
    smartScore: placeholderBreakdown.totalSmartScore,
    smartScoreBreakdown: placeholderBreakdown,
    eligibleVoucherIds,
    appliedVoucherId: null,
  };
}

// Round to whole minutes first, then split — otherwise 9.999h rounds to "09:60"/"09:00"
// (minute overflow was dropped instead of carried into the hour).
function formatArrivalFromHours(totalHours: number): string {
  const totalMinutes = Math.round(totalHours * 60);
  const days = Math.floor(totalMinutes / 1440);
  const minuteOfDay = totalMinutes % 1440;
  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
  const mm = String(minuteOfDay % 60).padStart(2, '0');
  return days > 0 ? `${hh}:${mm} +${days}d` : `${hh}:${mm}`;
}

export function formatDuration(hours: number): string {
  const totalMinutes = Math.max(0, Math.round((Number.isFinite(hours) ? hours : 0) * 60));
  const wholeHours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (mins === 0) return `${wholeHours}h`;
  return `${wholeHours}h ${mins}m`;
}

/**
 * Deterministic leg ids. A corridor that appears more than once in an itinerary
 * (e.g. IST→ATH … IST→ATH) gets a `-2`, `-3` suffix so leg ids stay unique —
 * duplicate ids broke selection state, React keys, and activeLegId highlighting.
 */
export function buildLegIds(stops: Pick<TripStop, 'iataCode'>[]): string[] {
  const seen = new Map<string, number>();
  const ids: string[] = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const base = `leg-${stops[i].iataCode.toLowerCase()}-${stops[i + 1].iataCode.toLowerCase()}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    ids.push(count === 1 ? base : `${base}-${count}`);
  }
  return ids;
}

export function buildLegsFromStops(
  stops: TripStop[],
  curatedCorridors: Record<string, TransitOption[]>,
  allVouchers: Voucher[],
  hourlyRateUsd: number,
  activeVouchers: Voucher[],
  previousSelectedMap?: Record<string, string>,
  scoring: { profile?: Partial<TravelerProfile> | null; passengers?: number } = {}
): TripLeg[] {
  const legs: TripLeg[] = [];
  const legIds = buildLegIds(stops);
  for (let i = 0; i < stops.length - 1; i++) {
    const fromStop = stops[i];
    const toStop = stops[i + 1];
    const corridorKey = `${fromStop.iataCode}-${toStop.iataCode}`;
    const legId = legIds[i];
    const distanceKm = haversineDistanceKm(fromStop.lat, fromStop.lng, toStop.lat, toStop.lng);

    const baseOptions = curatedCorridors[corridorKey]
      ? curatedCorridors[corridorKey].map((opt) => ({ ...opt, legId }))
      : synthesizeCorridorOptions(
          fromStop,
          toStop,
          legId,
          allVouchers,
          hourlyRateUsd,
          activeVouchers,
          scoring.profile
        );

    const rankedOptions = attachBookingUrls(
      recalculateOptionsWithVttsAndVouchers(
        baseOptions,
        hourlyRateUsd,
        activeVouchers,
        scoring.profile
      ),
      {
        fromCode: fromStop.iataCode,
        toCode: toStop.iataCode,
        fromCity: fromStop.city,
        toCity: toStop.city,
        date: fromStop.departureDate,
        passengers: scoring.passengers,
      }
    );

    const prevSelected = previousSelectedMap?.[legId];
    const validPrev = rankedOptions.some((o) => o.id === prevSelected);

    legs.push({
      id: legId,
      fromStopId: fromStop.id,
      toStopId: toStop.id,
      fromCity: fromStop.city,
      fromCode: fromStop.iataCode,
      toCity: toStop.city,
      toCode: toStop.iataCode,
      distanceKm,
      selectedOptionId: validPrev ? prevSelected! : rankedOptions[0]?.id ?? '',
      transitOptions: rankedOptions,
    });
  }
  return legs;
}

export function calculateBestModeFilterMatch(
  options: TransitOption[],
  mode: 'all' | TransitMode
): TransitOption[] {
  if (mode === 'all') return options;
  return options.filter((o) => o.mode === mode);
}
