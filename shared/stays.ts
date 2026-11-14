import { buildAgodaStayUrl, buildBookingStayUrl, PROVIDER_NAMES, type StayLinkContext } from './affiliate.ts';
import { diffDaysIso } from './dateUtils.ts';
import { resolveTravelerProfile, round2, sanitizeHourlyRate } from './smartScore.ts';
import type {
  StayCategory,
  StayLink,
  StayOption,
  StayScoreBreakdown,
  StaySearch,
  TravelerProfile,
  TripStop,
} from './types.ts';

/**
 * Stays layer ("Staying in [City]?"). There is no hotel inventory API behind this, so a stop gets
 * one card per *category* of accommodation with an estimated nightly price, never a named property
 * or a quoted rate. Each card links to Booking.com / Agoda with the same city, dates, guests and
 * (on Booking.com) property filter the card describes.
 *
 * Categories are ranked by the same VTTS idea as transport (lower is better, everything in USD):
 *
 *   score = priceWeight × stayPrice
 *         + timeWeight  × ( commute + comfort )
 *
 *   commute = nights × TRIPS_PER_DAY × minutesToCentre × r × adults
 *   comfort = nights × HOURS_AT_PROPERTY × comfortMultiplier × r × adults
 *
 * `comfortMultiplier` is the stay-side counterpart of the in-vehicle multiplier (a sleeper berth
 * counts 0.4× there): the share of the hours spent at the property that a traveller would pay to
 * avoid. A dorm bed costs little cash and a lot of rest; a central 5★ the reverse. So a low hourly
 * rate ranks hostels first and a high one moves the ranking up-market, exactly as the pacing
 * slider already does for flights against coaches.
 */

interface CategorySpec {
  category: StayCategory;
  title: string;
  description: string;
  /** USD per night at cost index 1.0, for one room (or one bed, for `perPerson`). */
  baseNightlyUsd: number;
  perPerson?: boolean;
  commuteMinutesOneWay: number;
  comfortMultiplier: number;
  starClass?: number;
  propertyType: NonNullable<StayLinkContext['filter']>['propertyType'];
}

const CATEGORIES: CategorySpec[] = [
  {
    category: 'hostel',
    title: 'Hostels',
    description: 'Bed in a shared dorm',
    baseNightlyUsd: 32,
    perPerson: true,
    commuteMinutesOneWay: 22,
    comfortMultiplier: 0.7,
    propertyType: 'hostel',
  },
  {
    category: 'budget',
    title: 'Budget hotels · 2★',
    description: 'Private room, outside the centre',
    baseNightlyUsd: 75,
    commuteMinutesOneWay: 25,
    comfortMultiplier: 0.35,
    starClass: 2,
    propertyType: 'hotel',
  },
  {
    category: 'midrange',
    title: 'Mid-range hotels · 3★',
    description: 'Private room near transit',
    baseNightlyUsd: 115,
    commuteMinutesOneWay: 15,
    comfortMultiplier: 0.2,
    starClass: 3,
    propertyType: 'hotel',
  },
  {
    category: 'apartment',
    title: 'Apartments',
    description: 'Entire place with a kitchen',
    baseNightlyUsd: 130,
    commuteMinutesOneWay: 18,
    comfortMultiplier: 0.22,
    propertyType: 'apartment',
  },
  {
    category: 'upscale',
    title: 'Upscale hotels · 4★',
    description: 'Central, full-service',
    baseNightlyUsd: 170,
    commuteMinutesOneWay: 8,
    comfortMultiplier: 0.08,
    starClass: 4,
    propertyType: 'hotel',
  },
  {
    category: 'luxury',
    title: 'Luxury hotels · 5★',
    description: 'Landmark address in the centre',
    baseNightlyUsd: 340,
    commuteMinutesOneWay: 6,
    comfortMultiplier: 0,
    starClass: 5,
    propertyType: 'hotel',
  },
];

const TRIPS_PER_DAY = 4; // out, back to rest, out again, back
const HOURS_AT_PROPERTY = 10; // sleep plus downtime, per night
const ADULTS_PER_ROOM = 2;

/** Rough accommodation price level relative to a mid-priced city (1.0). */
// prettier-ignore
const CITY_COST_INDEX: Record<string, number> = {
  london: 1.55, paris: 1.45, amsterdam: 1.4, zurich: 1.75, geneva: 1.7, copenhagen: 1.45,
  oslo: 1.4, stockholm: 1.3, dublin: 1.45, edinburgh: 1.35, rome: 1.2, venice: 1.5, milan: 1.3,
  florence: 1.25, barcelona: 1.25, madrid: 1.05, lisbon: 1.0, berlin: 1.0, munich: 1.3,
  vienna: 1.1, prague: 0.85, budapest: 0.75, warsaw: 0.7, krakow: 0.65, athens: 0.9,
  istanbul: 0.7, antalya: 0.6, dubai: 1.3, 'abu dhabi': 1.15, doha: 1.1, 'new york': 2.1,
  'san francisco': 1.75, 'los angeles': 1.6, chicago: 1.4, toronto: 1.3, tokyo: 1.2, kyoto: 1.25,
  osaka: 0.95, seoul: 0.95, 'hong kong': 1.4, singapore: 1.55, shanghai: 0.85, beijing: 0.8,
  taipei: 0.8, bangkok: 0.5, phuket: 0.7, 'kuala lumpur': 0.5, penang: 0.45, hanoi: 0.4,
  'ho chi minh city': 0.45, jakarta: 0.5, bali: 0.6, manila: 0.55, mumbai: 0.6, delhi: 0.5,
  cairo: 0.45, sydney: 1.45, melbourne: 1.25,
};

function costIndex(city: string): number {
  return CITY_COST_INDEX[city.trim().toLowerCase()] ?? 1;
}

interface ScorableStay {
  nightlyPriceUsd: number;
  commuteMinutesOneWay: number;
  comfortMultiplier: number;
}

export function computeStaySmartScore(
  stay: ScorableStay,
  nights: number,
  adults: number,
  rawHourlyRateUsd: number,
  profileInput?: Partial<TravelerProfile> | null
): StayScoreBreakdown {
  const hourlyRateUsd = sanitizeHourlyRate(rawHourlyRateUsd);
  const profile = resolveTravelerProfile(profileInput);
  const totalPriceUsd = round2(stay.nightlyPriceUsd * nights);

  const commuteHours = round2((nights * TRIPS_PER_DAY * stay.commuteMinutesOneWay * adults) / 60);
  const commutePenaltyUsd = round2(commuteHours * hourlyRateUsd);
  const comfortPenaltyUsd = round2(
    nights * HOURS_AT_PROPERTY * stay.comfortMultiplier * adults * hourlyRateUsd
  );

  return {
    nights,
    adults,
    nightlyPriceUsd: stay.nightlyPriceUsd,
    totalPriceUsd,
    hourlyRateUsd,
    commuteMinutesOneWay: stay.commuteMinutesOneWay,
    commuteHours,
    commutePenaltyUsd,
    comfortMultiplier: stay.comfortMultiplier,
    comfortPenaltyUsd,
    priceWeight: profile.priceWeight,
    timeWeight: profile.timeWeight,
    totalSmartScore: round2(
      totalPriceUsd * profile.priceWeight +
        (commutePenaltyUsd + comfortPenaltyUsd) * profile.timeWeight
    ),
  };
}

function partnerLinks(ctx: StayLinkContext): StayLink[] {
  const links: StayLink[] = [];
  const booking = buildBookingStayUrl(ctx);
  if (booking) links.push({ provider: 'booking', providerName: PROVIDER_NAMES.booking, url: booking });
  const agoda = buildAgodaStayUrl(ctx);
  if (agoda) links.push({ provider: 'agoda', providerName: PROVIDER_NAMES.agoda, url: agoda });
  return links;
}

/**
 * Stay search for one stop, ranked by Smart Score. Returns null when the stop has no nights
 * (the origin, or malformed dates).
 */
export function buildStaySearch(
  stop: TripStop,
  stopIndex: number,
  travelers: number,
  hourlyRateUsd: number,
  profile?: Partial<TravelerProfile> | null
): StaySearch | null {
  const nights = diffDaysIso(stop.arrivalDate, stop.departureDate);
  if (stopIndex === 0 || !Number.isFinite(nights) || nights < 1) return null;

  const adults = Math.min(9, Math.max(1, Math.floor(Number(travelers)) || 1));
  const rooms = Math.ceil(adults / ADULTS_PER_ROOM);
  const index = costIndex(stop.city);
  const base: StayLinkContext = {
    city: stop.city,
    country: stop.country,
    checkIn: stop.arrivalDate,
    checkOut: stop.departureDate,
    adults,
    rooms,
  };

  const options: StayOption[] = CATEGORIES.map((spec) => {
    const nightlyPriceUsd = Math.round(spec.baseNightlyUsd * index * (spec.perPerson ? adults : rooms));
    const breakdown = computeStaySmartScore(
      { ...spec, nightlyPriceUsd },
      nights,
      adults,
      hourlyRateUsd,
      profile
    );
    return {
      id: `${stop.id}-stay-${spec.category}`,
      stopId: stop.id,
      category: spec.category,
      title: spec.title,
      description: spec.description,
      starClass: spec.starClass,
      nightlyPriceUsd,
      totalPriceUsd: breakdown.totalPriceUsd,
      commuteMinutesOneWay: spec.commuteMinutesOneWay,
      smartScore: breakdown.totalSmartScore,
      smartScoreBreakdown: breakdown,
      dataSource: 'synthesized' as const,
      links: partnerLinks({
        ...base,
        filter: { starClass: spec.starClass, propertyType: spec.propertyType },
      }),
    };
  }).sort((a, b) => a.smartScore - b.smartScore);

  return {
    stopId: stop.id,
    stopIndex,
    city: stop.city,
    country: stop.country,
    checkIn: stop.arrivalDate,
    checkOut: stop.departureDate,
    nights,
    adults,
    rooms,
    links: partnerLinks(base),
    options,
  };
}

/** One search per stop that has a stay (every stop except the origin). */
export function buildStaySearches(
  stops: TripStop[],
  travelers: number,
  hourlyRateUsd: number,
  profile?: Partial<TravelerProfile> | null
): StaySearch[] {
  return stops
    .map((stop, index) => buildStaySearch(stop, index, travelers, hourlyRateUsd, profile))
    .filter((s): s is StaySearch => s !== null);
}
