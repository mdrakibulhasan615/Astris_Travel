/**
 * Types and helpers for the ground "schedules" view of a leg: real transit directions from the
 * Google Routes API and the 12Go regional timetable. Pure (no server or browser APIs).
 */

export type TransitVehicle = 'bus' | 'train' | 'subway' | 'tram' | 'ferry' | 'other';

/** One step of a transit route: walking, or riding a line. Paths are `[lat, lng]` pairs. */
export interface TransitStep {
  kind: 'walk' | 'transit';
  vehicle?: TransitVehicle;
  durationMinutes: number;
  distanceMeters: number;
  /** Walking instruction, e.g. "Walk to Gare du Nord". */
  instruction?: string;
  /** Line name and number, e.g. "Piccadilly line" / "RB1", and the agency that runs it. */
  lineName?: string;
  lineShortName?: string;
  operator?: string;
  /** Hex colour the agency uses for the line, when it gives one. */
  lineColor?: string;
  headsign?: string;
  fromStop?: string;
  toStop?: string;
  /** Local times as Google formats them ("9:30 AM"). */
  departureText?: string;
  arrivalText?: string;
  stopCount?: number;
  path: [number, number][];
}

export interface TransitRoute {
  durationMinutes: number;
  distanceKm: number;
  fare?: { currency: string; amount: number };
  departureText?: string;
  arrivalText?: string;
  steps: TransitStep[];
}

/** One mode of travel on one 12Go route, with when it leaves. */
export interface TwelveGoClass {
  /** 12Go's own class label ("Express", "VIP 24", "Minivan 7pax"). 12Go does not name the operator. */
  label: string;
  departures: string[];
}

export interface TwelveGoRoute {
  mode: 'bus' | 'train' | 'ferry' | 'van' | 'taxi';
  from: string;
  to: string;
  /** True when this is the requested city pair, false for a nearby terminal pair. */
  exact: boolean;
  priceMinUsd?: number;
  priceMaxUsd?: number;
  durationMinMinutes?: number;
  durationMaxMinutes?: number;
  classes: TwelveGoClass[];
  /** 12Go page for this route, carrying our partner id, the date and the party size. */
  url: string;
}

export interface GroundSchedules {
  google: { enabled: boolean; routes: TransitRoute[] };
  twelveGo: { supported: boolean; routes: TwelveGoRoute[] };
}

/**
 * Decodes a Google encoded polyline (precision 5) to `[lat, lng]` pairs.
 * https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
export function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of ['lat', 'lng'] as const) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        if (index >= encoded.length) return points;
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 'lat') lat += delta;
      else lng += delta;
    }
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

/** Map overlay style for a vehicle: trains and metro are blue (metro dashed), buses orange. */
export function overlayStyle(step: Pick<TransitStep, 'kind' | 'vehicle'>): {
  kind: 'rail' | 'subway' | 'bus' | 'walk';
  color: string;
} {
  if (step.kind === 'walk') return { kind: 'walk', color: '#9CA3AF' };
  switch (step.vehicle) {
    case 'bus':
      return { kind: 'bus', color: '#F97316' };
    case 'subway':
    case 'tram':
      return { kind: 'subway', color: '#2563EB' };
    default:
      return { kind: 'rail', color: '#2563EB' };
  }
}

export interface OverlayLine {
  kind: 'rail' | 'subway' | 'bus' | 'walk';
  color: string;
  /** `[lng, lat]` pairs, as GeoJSON wants them. */
  coordinates: [number, number][];
}

/** The lines a transit route draws on the map. */
export function routeToOverlay(route: TransitRoute): OverlayLine[] {
  return route.steps
    .filter((s) => s.path.length >= 2)
    .map((s) => ({
      ...overlayStyle(s),
      coordinates: s.path.map(([lat, lng]) => [lng, lat] as [number, number]),
    }));
}

/** `1h 05m` / `45m`. */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}
