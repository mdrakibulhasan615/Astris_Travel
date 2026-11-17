import { buildAgodaStayUrl, buildBookingStayUrl, PROVIDER_NAMES, type StayLinkContext } from './affiliate.ts';
import { diffDaysIso } from './dateUtils.ts';
import type { StayLink, StaySearch, TripStop } from './types.ts';

/**
 * Stays layer ("Staying in [City]?"). There is no hotel inventory behind this module, so it holds no
 * prices at all: each stop gets the city, the dates, the party and a Booking.com / Agoda search with
 * those filled in. Real hotels and their rates come from the live hotel search (`server/hotelService.ts`),
 * fetched when the traveller opens the card.
 */

const ADULTS_PER_ROOM = 2;

function partnerLinks(ctx: StayLinkContext): StayLink[] {
  const links: StayLink[] = [];
  const booking = buildBookingStayUrl(ctx);
  if (booking) links.push({ provider: 'booking', providerName: PROVIDER_NAMES.booking, url: booking });
  const agoda = buildAgodaStayUrl(ctx);
  if (agoda) links.push({ provider: 'agoda', providerName: PROVIDER_NAMES.agoda, url: agoda });
  return links;
}

/**
 * Stay search for one stop. Returns null when the stop has no nights (the origin, or malformed
 * dates).
 */
export function buildStaySearch(stop: TripStop, stopIndex: number, travelers: number): StaySearch | null {
  const nights = diffDaysIso(stop.arrivalDate, stop.departureDate);
  if (stopIndex === 0 || !Number.isFinite(nights) || nights < 1) return null;

  const adults = Math.min(9, Math.max(1, Math.floor(Number(travelers)) || 1));
  const rooms = Math.ceil(adults / ADULTS_PER_ROOM);
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
    links: partnerLinks({
      city: stop.city,
      country: stop.country,
      checkIn: stop.arrivalDate,
      checkOut: stop.departureDate,
      adults,
      rooms,
    }),
  };
}

/** One search per stop that has a stay (every stop except the origin). */
export function buildStaySearches(stops: TripStop[], travelers: number): StaySearch[] {
  return stops
    .map((stop, index) => buildStaySearch(stop, index, travelers))
    .filter((x): x is StaySearch => x !== null);
}
