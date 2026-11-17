import { buildLegsFromStops } from './smartScore.ts';
import type { DestinationHub, Trip, TripStop } from './types.ts';

export const DESTINATION_HUBS: DestinationHub[] = [
  {
    id: 'hub-kul',
    city: 'Kuala Lumpur',
    country: 'Malaysia',
    iataCode: 'KUL',
    lat: 3.139,
    lng: 101.6869,
    region: 'Southeast Asia',
    recommendedNights: 3,
    tagline: 'Petronas skyline, street markets & KLIA global hub',
  },
  {
    id: 'hub-ist',
    city: 'Istanbul',
    country: 'Turkey',
    iataCode: 'IST',
    lat: 41.0082,
    lng: 28.9784,
    region: 'Transcontinental',
    recommendedNights: 4,
    tagline: 'Bosphorus crossroads linking Asia and Europe',
  },
  {
    id: 'hub-lon',
    city: 'London',
    country: 'United Kingdom',
    iataCode: 'LON',
    lat: 51.5072,
    lng: -0.1276,
    region: 'Western Europe',
    recommendedNights: 4,
    tagline: 'St Pancras Eurostar gateway & Heathrow transatlantic hub',
  },
  {
    id: 'hub-par',
    city: 'Paris',
    country: 'France',
    iataCode: 'PAR',
    lat: 48.8566,
    lng: 2.3522,
    region: 'Western Europe',
    recommendedNights: 4,
    tagline: 'Gare du Nord rail terminus & culinary capital',
  },
  {
    id: 'hub-dxb',
    city: 'Dubai',
    country: 'UAE',
    iataCode: 'DXB',
    lat: 25.2048,
    lng: 55.2708,
    region: 'Middle East',
    recommendedNights: 3,
    tagline: 'Midpoint Gulf aviation hub between Asia and Europe',
  },
  {
    id: 'hub-rom',
    city: 'Rome',
    country: 'Italy',
    iataCode: 'ROM',
    lat: 41.9028,
    lng: 12.4964,
    region: 'Southern Europe',
    recommendedNights: 3,
    tagline: 'Termini high-speed rail corridor & ancient landmarks',
  },
  {
    id: 'hub-ams',
    city: 'Amsterdam',
    country: 'Netherlands',
    iataCode: 'AMS',
    lat: 52.3676,
    lng: 4.9041,
    region: 'Western Europe',
    recommendedNights: 3,
    tagline: 'Schiphol hub & Thalys/Eurostar canal network',
  },
  {
    id: 'hub-sin',
    city: 'Singapore',
    country: 'Singapore',
    iataCode: 'SIN',
    lat: 1.3521,
    lng: 103.8198,
    region: 'Southeast Asia',
    recommendedNights: 3,
    tagline: 'Changi international gateway & garden metropolis',
  },
];

/** A new trip starts at the origin only; the traveller adds every destination after it. */
export const INITIAL_STOPS: TripStop[] = [
  {
    id: 'stop-kul',
    order: 1,
    city: 'Kuala Lumpur',
    country: 'Malaysia',
    iataCode: 'KUL',
    lat: 3.139,
    lng: 101.6869,
    // Origin: a departure point, not a stay (single date). `stayNights` only matters if the stop
    // is later dragged to another position; see `stopNights` in dateUtils.
    stayNights: 3,
    arrivalDate: '2026-11-21',
    departureDate: '2026-11-21',
    notes: 'Depart KL Sentral via KLIA Ekspres (28m to terminal)',
  },
];

export function createDefaultTrip(): Trip {
  const hourlyTimeValue = 15; // Balanced Explorer default ($15/hr)
  return {
    id: 'trip-eurasia-2026',
    title: 'Your trip',
    travelers: 1,
    currency: 'USD',
    vttsTier: 'explorer',
    hourlyTimeValue,
    stops: INITIAL_STOPS,
    legs: buildLegsFromStops(INITIAL_STOPS, hourlyTimeValue),
  };
}
