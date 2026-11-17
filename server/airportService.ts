import airportsData from 'airports' with { type: 'json' };
import { DESTINATION_HUBS } from '../shared/destinations.ts';
import type { DestinationHub } from '../shared/types.ts';

export interface RawAirport {
  iata?: string | null;
  name?: string | null;
  lat?: string | number | null;
  lon?: string | number | null;
  iso?: string | null;
  continent?: string | null;
  type?: string | null;
  size?: string | null;
  status?: number;
}

const ISO_COUNTRY_NAMES: Record<string, string> = {
  US: 'United States',
  GB: 'United Kingdom',
  FR: 'France',
  DE: 'Germany',
  IT: 'Italy',
  ES: 'Spain',
  TR: 'Turkey',
  MY: 'Malaysia',
  JP: 'Japan',
  CN: 'China',
  SG: 'Singapore',
  AE: 'United Arab Emirates',
  AU: 'Australia',
  CA: 'Canada',
  TH: 'Thailand',
  ID: 'Indonesia',
  KR: 'South Korea',
  IN: 'India',
  BR: 'Brazil',
  MX: 'Mexico',
  NL: 'Netherlands',
  CH: 'Switzerland',
  AT: 'Austria',
  GR: 'Greece',
  PT: 'Portugal',
  IE: 'Ireland',
  NZ: 'New Zealand',
  ZA: 'South Africa',
  EG: 'Egypt',
  VN: 'Vietnam',
  PH: 'Philippines',
  HK: 'Hong Kong',
  TW: 'Taiwan',
  QA: 'Qatar',
  SA: 'Saudi Arabia',
  NO: 'Norway',
  SE: 'Sweden',
  DK: 'Denmark',
  FI: 'Finland',
  PL: 'Poland',
  CZ: 'Czech Republic',
  HU: 'Hungary',
  IS: 'Iceland',
  AR: 'Argentina',
  CL: 'Chile',
  CO: 'Colombia',
  PE: 'Peru',
  MA: 'Morocco',
};

const CONTINENT_NAMES: Record<string, string> = {
  EU: 'Europe',
  AS: 'Asia',
  NA: 'North America',
  SA: 'South America',
  AF: 'Africa',
  OC: 'Oceania',
  AN: 'Antarctica',
};

// Curated overrides for popular international hub IATA codes where raw name or city may need refinement
const CURATED_IATA_OVERRIDES: Record<
  string,
  { city: string; name: string; country: string; region: string }
> = {
  IST: { city: 'Istanbul', name: 'Istanbul Airport', country: 'Turkey', region: 'Transcontinental' },
  SAW: { city: 'Istanbul', name: 'Sabiha Gokcen Airport', country: 'Turkey', region: 'Transcontinental' },
  KUL: { city: 'Kuala Lumpur', name: 'Kuala Lumpur International Airport', country: 'Malaysia', region: 'Southeast Asia' },
  LHR: { city: 'London', name: 'London Heathrow Airport', country: 'United Kingdom', region: 'Western Europe' },
  LGW: { city: 'London', name: 'London Gatwick Airport', country: 'United Kingdom', region: 'Western Europe' },
  STN: { city: 'London', name: 'London Stansted Airport', country: 'United Kingdom', region: 'Western Europe' },
  CDG: { city: 'Paris', name: 'Paris Charles de Gaulle Airport', country: 'France', region: 'Western Europe' },
  ORY: { city: 'Paris', name: 'Paris Orly Airport', country: 'France', region: 'Western Europe' },
  HND: { city: 'Tokyo', name: 'Tokyo Haneda International Airport', country: 'Japan', region: 'East Asia' },
  NRT: { city: 'Tokyo', name: 'Tokyo Narita International Airport', country: 'Japan', region: 'East Asia' },
  JFK: { city: 'New York', name: 'John F. Kennedy International Airport', country: 'United States', region: 'North America' },
  EWR: { city: 'New York', name: 'Newark Liberty International Airport', country: 'United States', region: 'North America' },
  DXB: { city: 'Dubai', name: 'Dubai International Airport', country: 'United Arab Emirates', region: 'Middle East' },
  SIN: { city: 'Singapore', name: 'Singapore Changi Airport', country: 'Singapore', region: 'Southeast Asia' },
  AMS: { city: 'Amsterdam', name: 'Amsterdam Schiphol Airport', country: 'Netherlands', region: 'Western Europe' },
  FRA: { city: 'Frankfurt', name: 'Frankfurt am Main Airport', country: 'Germany', region: 'Western Europe' },
  FCO: { city: 'Rome', name: 'Rome Leonardo da Vinci Fiumicino Airport', country: 'Italy', region: 'Southern Europe' },
  MAD: { city: 'Madrid', name: 'Madrid-Barajas Adolfo Suárez Airport', country: 'Spain', region: 'Southern Europe' },
  BCN: { city: 'Barcelona', name: 'Barcelona-El Prat Airport', country: 'Spain', region: 'Southern Europe' },
  SYD: { city: 'Sydney', name: 'Sydney Kingsford Smith Airport', country: 'Australia', region: 'Oceania' },
  MEL: { city: 'Melbourne', name: 'Melbourne Tullamarine Airport', country: 'Australia', region: 'Oceania' },
  BKK: { city: 'Bangkok', name: 'Bangkok Suvarnabhumi Airport', country: 'Thailand', region: 'Southeast Asia' },
  ICN: { city: 'Seoul', name: 'Seoul Incheon International Airport', country: 'South Korea', region: 'East Asia' },
  SFO: { city: 'San Francisco', name: 'San Francisco International Airport', country: 'United States', region: 'North America' },
  LAX: { city: 'Los Angeles', name: 'Los Angeles International Airport', country: 'United States', region: 'North America' },
  ORD: { city: 'Chicago', name: "Chicago O'Hare International Airport", country: 'United States', region: 'North America' },
  YYZ: { city: 'Toronto', name: 'Toronto Pearson International Airport', country: 'Canada', region: 'North America' },
  DOH: { city: 'Doha', name: 'Hamad International Airport', country: 'Qatar', region: 'Middle East' },
  ZRH: { city: 'Zurich', name: 'Zurich Airport', country: 'Switzerland', region: 'Central Europe' },
  VIE: { city: 'Vienna', name: 'Vienna International Airport', country: 'Austria', region: 'Central Europe' },
};

function cleanCityName(rawName: string, iata: string): string {
  if (CURATED_IATA_OVERRIDES[iata]) {
    return CURATED_IATA_OVERRIDES[iata].city;
  }
  // Remove suffixes like "International Airport", "Airport", "Municipal", "Air Base"
  const cleaned = rawName
    .replace(/\b(International\s+Airport|Regional\s+Airport|Metropolitan\s+Airport|Airport|Air Base|Heliport|Seaplane Base)\b/gi, '')
    .trim();
  // If cleaned has dashes or slashes, take primary
  const firstPart = cleaned.split(/[/,-]/)[0]?.trim();
  return firstPart || rawName || iata;
}

export interface EnrichedAirport extends DestinationHub {
  airportName: string;
  size?: string;
  type?: string;
}

// Pre-index clean airports
const ALL_AIRPORTS: EnrichedAirport[] = [];

function initializeAirports() {
  if (ALL_AIRPORTS.length > 0) return;

  const rawList = (airportsData as unknown as RawAirport[]) || [];

  for (const raw of rawList) {
    if (!raw.iata || raw.iata.length !== 3 || raw.type === 'closed') continue;
    const lat = Number(raw.lat);
    const lng = Number(raw.lon);
    if (isNaN(lat) || isNaN(lng)) continue;

    const iata = raw.iata.toUpperCase();
    const override = CURATED_IATA_OVERRIDES[iata];
    const hubMatch = DESTINATION_HUBS.find((h) => h.iataCode === iata);

    const country =
      override?.country ||
      hubMatch?.country ||
      (raw.iso ? ISO_COUNTRY_NAMES[raw.iso] || raw.iso : 'International');

    const region =
      override?.region ||
      hubMatch?.region ||
      (raw.continent ? CONTINENT_NAMES[raw.continent] || raw.continent : 'Global');

    const airportName =
      override?.name ||
      raw.name ||
      (hubMatch ? `${hubMatch.city} Airport` : `${iata} Airport`);

    const city =
      override?.city ||
      hubMatch?.city ||
      cleanCityName(airportName, iata);

    const hub: EnrichedAirport = {
      id: `hub-${iata.toLowerCase()}`,
      iataCode: iata,
      city,
      country,
      lat,
      lng,
      region,
      recommendedNights: hubMatch?.recommendedNights || (raw.size === 'large' ? 4 : 3),
      tagline: airportName,
      airportName,
      size: raw.size || undefined,
      type: raw.type || 'airport',
    };

    ALL_AIRPORTS.push(hub);
  }

  console.log(`[Airport Service] Indexed ${ALL_AIRPORTS.length} global IATA airports.`);
}

initializeAirports();

export function searchAirports(query: string, limit: number = 15): DestinationHub[] {
  initializeAirports();
  const q = query.trim().toLowerCase();

  if (!q) {
    // Return curated destination hubs as popular suggestions
    return DESTINATION_HUBS.slice(0, limit);
  }

  const matches: Array<{ hub: EnrichedAirport; score: number }> = [];

  for (const airport of ALL_AIRPORTS) {
    const iata = airport.iataCode.toLowerCase();
    const city = airport.city.toLowerCase();
    const country = airport.country.toLowerCase();
    const name = airport.airportName.toLowerCase();

    let score = 0;

    // Highest rank: Exact IATA match
    if (iata === q) {
      score += 200;
    } else if (iata.startsWith(q)) {
      score += 120;
    }

    // Exact city match
    if (city === q) {
      score += 150;
    } else if (city.startsWith(q)) {
      score += 100;
    } else if (city.includes(q)) {
      score += 60;
    }

    // Airport name prefix or inclusion
    if (name.startsWith(q)) {
      score += 80;
    } else if (name.includes(q)) {
      score += 40;
    }

    // Country match
    if (country.startsWith(q)) {
      score += 50;
    } else if (country.includes(q)) {
      score += 25;
    }

    if (score === 0) continue;

    // Prioritize major global airports
    if (airport.size === 'large') score += 20;
    else if (airport.size === 'medium') score += 10;

    matches.push({ hub: airport, score });
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, limit).map((m) => m.hub);
}

export function getAirportByIata(iataCode: string): DestinationHub | null {
  initializeAirports();
  const code = iataCode.trim().toUpperCase();
  return ALL_AIRPORTS.find((a) => a.iataCode === code) || null;
}
