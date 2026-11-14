import type {
  SmartScoreBreakdown,
  TransitMode,
  TransitOption,
  TripLeg,
  TripStop,
  Voucher,
  VttsPreset,
} from './types.ts';

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
  const p = Math.max(0, Math.min(100, Math.round(percent)));
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

export function getLayoverMultiplier(layoverHours: number): number {
  if (layoverHours <= 0) return 0;
  if (layoverHours < 2) return 1.0;
  if (layoverHours < 6) return 1.5;
  return 2.5;
}

export function getModeMultiplier(isOvernightSleeper: boolean): number {
  return isOvernightSleeper ? 0.4 : 1.0;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function calculateVoucherDiscount(
  option: Pick<TransitOption, 'basePriceUsd' | 'mode' | 'carrierCode' | 'eligibleVoucherIds'>,
  voucher: Voucher | null | undefined
): number {
  if (!voucher) return 0;
  if (!voucher.applicableModes.includes(option.mode)) return 0;
  if (option.basePriceUsd < voucher.minSpendUsd) return 0;
  if (
    voucher.applicableCarriers &&
    voucher.applicableCarriers.length > 0 &&
    !voucher.applicableCarriers.includes(option.carrierCode)
  ) {
    return 0;
  }

  let discount =
    voucher.discountType === 'percentage'
      ? (option.basePriceUsd * voucher.discountValue) / 100
      : voucher.discountValue;

  if (voucher.maxDiscountUsd !== undefined) {
    discount = Math.min(discount, voucher.maxDiscountUsd);
  }

  return round2(Math.min(discount, option.basePriceUsd));
}

export function computeSmartScore(
  option: Pick<
    TransitOption,
    'basePriceUsd' | 'inVehicleHours' | 'layoverHours' | 'isOvernightSleeper' | 'mode' | 'carrierCode' | 'eligibleVoucherIds'
  >,
  hourlyRateUsd: number,
  bestVoucher?: Voucher | null
): SmartScoreBreakdown {
  const discountAppliedUsd = calculateVoucherDiscount(option, bestVoucher);
  const discountedPriceUsd = round2(Math.max(0, option.basePriceUsd - discountAppliedUsd));

  const modeMultiplier = getModeMultiplier(option.isOvernightSleeper);
  // Layover penalty: linear cap — first 3h at 0.5×, beyond 3h at 1.2× (no compounding)
  const layoverPenaltyUsd = round2(
    Math.min(option.layoverHours, 3) * hourlyRateUsd * 0.5 +
    Math.max(0, option.layoverHours - 3) * hourlyRateUsd * 1.2
  );
  // Effective multiplier for breakdown display (penalty ÷ raw layover hours)
  const layoverMultiplier = option.layoverHours > 0
    ? round2(layoverPenaltyUsd / (option.layoverHours * hourlyRateUsd))
    : 0;

  const inVehiclePenaltyUsd = round2(option.inVehicleHours * hourlyRateUsd * modeMultiplier);
  // 1.5× price sensitivity: a $78 price drop easily outweighs a 1-2h transit extension
  const totalSmartScore = round2(discountedPriceUsd * 1.5 + inVehiclePenaltyUsd + layoverPenaltyUsd);

  return {
    basePriceUsd: option.basePriceUsd,
    discountAppliedUsd,
    discountedPriceUsd,
    hourlyRateUsd,
    inVehicleHours: option.inVehicleHours,
    modeMultiplier,
    inVehiclePenaltyUsd,
    layoverHours: option.layoverHours,
    layoverMultiplier,
    layoverPenaltyUsd,
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
  activeVouchers: Voucher[]
): TransitOption[] {
  return options
    .map((option) => {
      const { voucher } = pickBestActiveVoucher(option, activeVouchers);
      const breakdown = computeSmartScore(option, hourlyRateUsd, voucher);
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
  activeVouchers: Voucher[]
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

  return recalculateOptionsWithVttsAndVouchers(options, hourlyRateUsd, activeVouchers);
}

function buildRawOption(
  partial: Omit<
    TransitOption,
    'discountedPriceUsd' | 'smartScore' | 'smartScoreBreakdown' | 'eligibleVoucherIds'
  >,
  allVouchers: Voucher[]
): TransitOption {
  const eligibleVoucherIds = allVouchers
    .filter((v) => v.applicableModes.includes(partial.mode) && partial.basePriceUsd >= v.minSpendUsd)
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

function formatArrivalFromHours(totalHours: number): string {
  const days = Math.floor(totalHours / 24);
  const rem = totalHours % 24;
  const hrs = Math.floor(rem);
  const mins = Math.round((rem - hrs) * 60) % 60;
  const hh = String(hrs).padStart(2, '0');
  const mm = String(mins).padStart(2, '0');
  return days > 0 ? `${hh}:${mm} +${days}d` : `${hh}:${mm}`;
}

export function formatDuration(hours: number): string {
  const wholeHours = Math.floor(hours);
  const mins = Math.round((hours - wholeHours) * 60);
  if (mins === 0) return `${wholeHours}h`;
  return `${wholeHours}h ${mins}m`;
}

export function buildLegsFromStops(
  stops: TripStop[],
  curatedCorridors: Record<string, TransitOption[]>,
  allVouchers: Voucher[],
  hourlyRateUsd: number,
  activeVouchers: Voucher[],
  previousSelectedMap?: Record<string, string>
): TripLeg[] {
  const legs: TripLeg[] = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const fromStop = stops[i];
    const toStop = stops[i + 1];
    const corridorKey = `${fromStop.iataCode}-${toStop.iataCode}`;
    const legId = `leg-${fromStop.iataCode.toLowerCase()}-${toStop.iataCode.toLowerCase()}`;
    const distanceKm = haversineDistanceKm(fromStop.lat, fromStop.lng, toStop.lat, toStop.lng);

    const baseOptions = curatedCorridors[corridorKey]
      ? curatedCorridors[corridorKey].map((opt) => ({ ...opt, legId }))
      : synthesizeCorridorOptions(fromStop, toStop, legId, allVouchers, hourlyRateUsd, activeVouchers);

    const rankedOptions = recalculateOptionsWithVttsAndVouchers(
      baseOptions,
      hourlyRateUsd,
      activeVouchers
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
