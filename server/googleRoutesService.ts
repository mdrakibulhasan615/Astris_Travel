import { getEnv, warnMissingKey } from './env.ts';
import { getJson, setJson } from './jsonCache.ts';
import { decodePolyline, type TransitRoute, type TransitStep, type TransitVehicle } from '../shared/groundSchedule.ts';

/**
 * Real public-transport directions from the Google Routes API (`travelMode: TRANSIT`): the lines to
 * ride, who runs them, stops, times, fare when Google has one, and a polyline per step for the map.
 *
 * It is a paid API (billed per request once the free monthly allowance is used), so it is only
 * called when `GOOGLE_MAPS_API_KEY` is set, only for a leg the user opens, and every answer is cached
 * for 7 days. Restrict the key to the Routes API in Google Cloud and set a quota.
 */

const ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const TIMEOUT_MS = 9000;
const MAX_ROUTES = 3;

export const googleMapsKey = (): string | undefined => getEnv('GOOGLE_MAPS_API_KEY');

export type TransitMode = 'BUS' | 'TRAIN' | 'SUBWAY' | 'RAIL';
export const DEFAULT_TRANSIT_MODES: TransitMode[] = ['BUS', 'TRAIN', 'SUBWAY', 'RAIL'];

const FIELD_MASK = [
  'routes.duration',
  'routes.distanceMeters',
  'routes.legs.steps.travelMode',
  'routes.legs.steps.staticDuration',
  'routes.legs.steps.distanceMeters',
  'routes.legs.steps.polyline.encodedPolyline',
  'routes.legs.steps.navigationInstruction.instructions',
  'routes.legs.steps.transitDetails',
  'routes.travelAdvisory.transitFare',
].join(',');

export interface GoogleTransitQuery {
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  /** `YYYY-MM-DD`; transit is timetable-based, so a future date gets that day's services. */
  date?: string;
  modes?: TransitMode[];
}

const seconds = (value: unknown): number => {
  const n = Number.parseFloat(String(value ?? '').replace(/s$/, ''));
  return Number.isFinite(n) ? n : 0;
};

function vehicleOf(type: string | undefined): TransitVehicle {
  switch (type) {
    case 'BUS':
    case 'INTERCITY_BUS':
    case 'TROLLEYBUS':
    case 'SHARE_TAXI':
      return 'bus';
    case 'SUBWAY':
    case 'METRO_RAIL':
    case 'MONORAIL':
      return 'subway';
    case 'TRAM':
    case 'LIGHT_RAIL':
    case 'CABLE_CAR':
    case 'FUNICULAR':
    case 'GONDOLA_LIFT':
      return 'tram';
    case 'FERRY':
      return 'ferry';
    case 'HEAVY_RAIL':
    case 'COMMUTER_TRAIN':
    case 'HIGH_SPEED_TRAIN':
    case 'LONG_DISTANCE_TRAIN':
    case 'RAIL':
      return 'train';
    default:
      return 'other';
  }
}

interface RawStep {
  travelMode?: string;
  staticDuration?: string;
  distanceMeters?: number;
  polyline?: { encodedPolyline?: string };
  navigationInstruction?: { instructions?: string };
  transitDetails?: {
    stopDetails?: { arrivalStop?: { name?: string }; departureStop?: { name?: string } };
    localizedValues?: {
      arrivalTime?: { time?: { text?: string } };
      departureTime?: { time?: { text?: string } };
    };
    headsign?: string;
    transitLine?: {
      name?: string;
      nameShort?: string;
      color?: string;
      agencies?: { name?: string }[];
      vehicle?: { type?: string };
    };
    stopCount?: number;
  };
}

interface RawRoute {
  duration?: string;
  distanceMeters?: number;
  legs?: { steps?: RawStep[] }[];
  travelAdvisory?: { transitFare?: { currencyCode?: string; units?: string; nanos?: number } };
}

/** One Google route to our shape. Exported for tests. */
export function parseRoute(raw: RawRoute): TransitRoute | null {
  const rawSteps = (raw.legs ?? []).flatMap((l) => l.steps ?? []);
  const steps: TransitStep[] = rawSteps.map((s): TransitStep => {
    const path = s.polyline?.encodedPolyline ? decodePolyline(s.polyline.encodedPolyline) : [];
    const base = {
      durationMinutes: Math.max(1, Math.round(seconds(s.staticDuration) / 60)),
      distanceMeters: Math.round(s.distanceMeters ?? 0),
      path,
    };
    const t = s.transitDetails;
    if (s.travelMode !== 'TRANSIT' || !t) {
      return { ...base, kind: 'walk', instruction: s.navigationInstruction?.instructions };
    }
    const line = t.transitLine;
    return {
      ...base,
      kind: 'transit',
      vehicle: vehicleOf(line?.vehicle?.type),
      lineName: line?.name,
      lineShortName: line?.nameShort,
      operator: line?.agencies?.map((a) => a.name).filter(Boolean).join(' / ') || undefined,
      lineColor: line?.color,
      headsign: t.headsign,
      fromStop: t.stopDetails?.departureStop?.name,
      toStop: t.stopDetails?.arrivalStop?.name,
      departureText: t.localizedValues?.departureTime?.time?.text,
      arrivalText: t.localizedValues?.arrivalTime?.time?.text,
      stopCount: t.stopCount,
    };
  });
  const ridden = steps.filter((s) => s.kind === 'transit');
  const duration = Math.round(seconds(raw.duration) / 60);
  if (steps.length === 0 || duration <= 0 || ridden.length === 0) return null;

  const fare = raw.travelAdvisory?.transitFare;
  const amount = fare ? Number(fare.units ?? 0) + (fare.nanos ?? 0) / 1e9 : 0;
  return {
    durationMinutes: duration,
    distanceKm: Math.round(((raw.distanceMeters ?? 0) / 1000) * 10) / 10,
    fare: fare?.currencyCode && amount > 0 ? { currency: fare.currencyCode, amount: Math.round(amount * 100) / 100 } : undefined,
    departureText: ridden[0].departureText,
    arrivalText: ridden[ridden.length - 1].arrivalText,
    steps,
  };
}

const r3 = (n: number) => n.toFixed(3);

/** Transit alternatives for a trip between two points, or null when there is no key or no route. */
export async function fetchGoogleTransitRoutes(q: GoogleTransitQuery): Promise<TransitRoute[] | null> {
  const key = googleMapsKey();
  if (!key) {
    warnMissingKey('GOOGLE_MAPS_API_KEY', 'transit directions');
    return null;
  }
  const modes = (q.modes?.length ? q.modes : DEFAULT_TRANSIT_MODES).slice().sort();
  const cacheKey = `routes:transit:${r3(q.from.lat)},${r3(q.from.lng)}:${r3(q.to.lat)},${r3(q.to.lng)}:${modes.join('+')}:${q.date ?? 'any'}`;
  const cached = await getJson<TransitRoute[]>(cacheKey);
  if (cached) return cached.length > 0 ? cached : null;

  // Transit needs a future departure to pick a day's timetable; a past or missing date means "now"
  const when = q.date ? Date.parse(`${q.date}T08:00:00Z`) : NaN;
  const body: Record<string, unknown> = {
    origin: { location: { latLng: { latitude: q.from.lat, longitude: q.from.lng } } },
    destination: { location: { latLng: { latitude: q.to.lat, longitude: q.to.lng } } },
    travelMode: 'TRANSIT',
    computeAlternativeRoutes: true,
    transitPreferences: { allowedTravelModes: modes },
    languageCode: 'en',
    units: 'METRIC',
    ...(Number.isFinite(when) && when > Date.now() ? { departureTime: new Date(when).toISOString() } : {}),
  };

  try {
    console.log(`[Google Routes] TRANSIT ${r3(q.from.lat)},${r3(q.from.lng)} -> ${r3(q.to.lat)},${r3(q.to.lng)} ${q.date ?? ''}`);
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELD_MASK },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      console.warn(`[Google Routes] ${res.status}: ${detail?.error?.message ?? res.statusText}`);
      return null;
    }
    const data = (await res.json()) as { routes?: RawRoute[] };
    const routes = (data.routes ?? [])
      .map(parseRoute)
      .filter((r): r is TransitRoute => r !== null)
      .slice(0, MAX_ROUTES);
    // An empty answer is cached too: "no transit here" does not change within a week
    await setJson(cacheKey, routes);
    return routes.length > 0 ? routes : null;
  } catch (err) {
    console.warn('[Google Routes] Request failed or timed out:', err);
    return null;
  }
}
