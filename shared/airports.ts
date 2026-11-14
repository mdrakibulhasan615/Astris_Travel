import type { TransitOption, TransitSegment } from './types.ts';

/**
 * Airport anchoring. Flight segments must start and end on the exact tarmac coordinates of an
 * airport — never a city centre (`DESTINATION_HUBS`), a rail station, or a synthetic offset —
 * and any ground travel to/from the airport is a separate connecting segment.
 *
 * Pure and dependency-free so the same rules run on the server (full `airports` dataset,
 * registered via `registerAirportResolver`) and in the browser (built-in table below).
 */

export interface AirportPoint {
  code: string;
  name: string;
  lat: number;
  lng: number;
}

const a = (code: string, name: string, lat: number, lng: number): [string, AirportPoint] => [
  code,
  { code, name, lat, lng },
];

/** Exact airport coordinates for every airport the curated data and hub list rely on. */
const CORE_AIRPORTS: Record<string, AirportPoint> = Object.fromEntries([
  a('KUL', 'Kuala Lumpur Intl', 2.7456, 101.7099),
  a('IST', 'Istanbul Airport', 41.2753, 28.7519),
  a('SAW', 'Sabiha Gokcen', 40.8986, 29.3092),
  a('LHR', 'London Heathrow', 51.47, -0.4543),
  a('LGW', 'London Gatwick', 51.1537, -0.1821),
  a('STN', 'London Stansted', 51.886, 0.235),
  a('LTN', 'London Luton', 51.8747, -0.3683),
  a('LCY', 'London City', 51.5053, 0.0553),
  a('CDG', 'Paris Charles de Gaulle', 49.0097, 2.5479),
  a('ORY', 'Paris Orly', 48.7262, 2.3652),
  a('FCO', 'Rome Fiumicino', 41.8003, 12.2389),
  a('AMS', 'Amsterdam Schiphol', 52.3086, 4.7639),
  a('SIN', 'Singapore Changi', 1.3644, 103.9915),
  a('DXB', 'Dubai Intl', 25.2532, 55.3657),
  a('DOH', 'Doha Hamad', 25.2731, 51.6081),
  a('AUH', 'Abu Dhabi Intl', 24.433, 54.6511),
  a('JED', 'Jeddah King Abdulaziz', 21.6796, 39.1565),
  a('ATH', 'Athens Intl', 37.9364, 23.9445),
  a('AYT', 'Antalya', 36.8987, 30.8005),
  a('ADB', 'Izmir Adnan Menderes', 38.2924, 27.157),
  a('FRA', 'Frankfurt', 50.0379, 8.5622),
  a('HKG', 'Hong Kong Intl', 22.308, 113.9185),
  a('JFK', 'New York JFK', 40.6413, -73.7781),
  a('BKK', 'Bangkok Suvarnabhumi', 13.69, 100.7501),
  a('HND', 'Tokyo Haneda', 35.5494, 139.7798),
]);

/** Metropolitan "city" codes used for trip stops → the primary airport that serves them. */
const CITY_PRIMARY_AIRPORT: Record<string, string> = {
  LON: 'LHR',
  PAR: 'CDG',
  ROM: 'FCO',
  NYC: 'JFK',
  TYO: 'HND',
  MIL: 'MXP',
  STO: 'ARN',
  MOW: 'SVO',
  BUH: 'OTP',
  BJS: 'PEK',
  SEL: 'ICN',
  OSA: 'KIX',
};

type AirportResolver = (code: string) => AirportPoint | null;
let externalResolver: AirportResolver | null = null;

/** Server registers the full `airports` dataset; the browser relies on the built-in table. */
export function registerAirportResolver(resolver: AirportResolver | null): void {
  externalResolver = resolver;
}

const IATA_RE = /^[A-Za-z]{3}$/;

/** Maps a city code (LON) to its primary airport code (LHR); airport codes pass through. */
export function toAirportCode(code: string): string {
  const upper = (code || '').trim().toUpperCase();
  return CITY_PRIMARY_AIRPORT[upper] ?? upper;
}

/** Exact airport coordinates for an airport *or* city code, or null when unknown. */
export function resolveAirport(code: string): AirportPoint | null {
  if (!code || !IATA_RE.test(code.trim())) return null;
  const airportCode = toAirportCode(code);
  const core = CORE_AIRPORTS[airportCode];
  if (core) return core;
  try {
    return externalResolver?.(airportCode) ?? null;
  } catch {
    return null;
  }
}

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Snaps every flight segment's endpoints to the exact coordinates (and airport IATA codes) of its
 * origin/destination airports. Ground segments are untouched. Segments whose codes can't be
 * resolved keep their coordinates. Returns new objects; inputs are not mutated.
 */
export function anchorFlightSegments(segments: TransitSegment[]): TransitSegment[] {
  return segments.map((seg) => {
    if (seg.mode !== 'flight') return seg;
    const from = resolveAirport(seg.fromCode);
    const to = resolveAirport(seg.toCode);
    return {
      ...seg,
      ...(from && { fromCode: from.code, fromLat: from.lat, fromLng: from.lng }),
      ...(to && { toCode: to.code, toLat: to.lat, toLng: to.lng }),
    };
  });
}

interface CityPoint {
  city: string;
  iataCode: string;
  lat: number;
  lng: number;
}

const CONNECTOR_MIN_KM = 3; // closer than this, the airport *is* the stop (no transfer to draw)

/**
 * Guarantees flights are bracketed by separate ground connectors: if the first/last segment is a
 * flight and its airport is not at the stop's location, a distinct "Airport transfer" segment
 * (city → airport / airport → city) is added so the flight line itself stays airport-to-airport.
 * Existing connectors are preserved. Returns a new array.
 */
export function ensureAirportConnectors(
  segments: TransitSegment[],
  fromStop?: CityPoint,
  toStop?: CityPoint,
  idPrefix = 'conn'
): TransitSegment[] {
  if (segments.length === 0) return segments;
  const result = [...segments];

  const first = result[0];
  if (fromStop && first.mode === 'flight') {
    const km = distanceKm(fromStop.lat, fromStop.lng, first.fromLat, first.fromLng);
    if (km > CONNECTOR_MIN_KM) {
      result.unshift({
        id: `${idPrefix}-origin-transfer`,
        mode: 'train',
        label: `${fromStop.city} → ${first.fromCode} transfer`,
        fromName: fromStop.city,
        fromCode: fromStop.iataCode,
        fromLat: fromStop.lat,
        fromLng: fromStop.lng,
        toName: `${first.fromCode} Airport`,
        toCode: first.fromCode,
        toLat: first.fromLat,
        toLng: first.fromLng,
        durationMinutes: Math.max(15, Math.round(km / 0.9)), // ~55 km/h airport rail/express bus
      });
    }
  }

  const last = result[result.length - 1];
  if (toStop && last.mode === 'flight') {
    const km = distanceKm(toStop.lat, toStop.lng, last.toLat, last.toLng);
    if (km > CONNECTOR_MIN_KM) {
      result.push({
        id: `${idPrefix}-destination-transfer`,
        mode: 'train',
        label: `${last.toCode} → ${toStop.city} transfer`,
        fromName: `${last.toCode} Airport`,
        fromCode: last.toCode,
        fromLat: last.toLat,
        fromLng: last.toLng,
        toName: toStop.city,
        toCode: toStop.iataCode,
        toLat: toStop.lat,
        toLng: toStop.lng,
        durationMinutes: Math.max(15, Math.round(km / 0.9)),
      });
    }
  }

  return result;
}

/** Anchor flights to airports, then bracket them with ground connectors. Idempotent. */
export function normalizeOptionGeometry<T extends Pick<TransitOption, 'id' | 'segments'>>(
  option: T,
  fromStop?: CityPoint,
  toStop?: CityPoint
): T {
  if (!option.segments || option.segments.length === 0) return option;
  const anchored = anchorFlightSegments(option.segments);
  return { ...option, segments: ensureAirportConnectors(anchored, fromStop, toStop, option.id) };
}

/** Largest-first great-circle detour helper for choosing a realistic connection airport. */
export function pickConnectionHub(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  excludeCodes: string[] = []
): AirportPoint {
  const candidates = ['IST', 'DOH', 'DXB', 'FRA', 'AMS', 'SIN', 'HKG', 'JFK'];
  let best: AirportPoint | null = null;
  let bestDetour = Infinity;
  for (const code of candidates) {
    if (excludeCodes.includes(code)) continue;
    const ap = CORE_AIRPORTS[code];
    if (!ap) continue;
    const detour = distanceKm(from.lat, from.lng, ap.lat, ap.lng) + distanceKm(ap.lat, ap.lng, to.lat, to.lng);
    if (detour < bestDetour) {
      bestDetour = detour;
      best = ap;
    }
  }
  return best ?? CORE_AIRPORTS.IST;
}
