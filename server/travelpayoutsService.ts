import { getEnv, warnMissingKey } from './env.ts';
import { VOUCHERS_CATALOG } from '../shared/mockDataset.ts';
import { resolveAirport } from '../shared/airports.ts';
import { computeSmartScore, haversineDistanceKm, round2 } from '../shared/smartScore.ts';
import type {
  FlightHop,
  TransitMode,
  TransitOption,
  TransitSegment,
  TravelerProfile,
  Voucher,
} from '../shared/types.ts';

/**
 * Flight fares from the free Aviasales Data API (Travelpayouts). Used in sample-data mode so the
 * cards show real prices instead of invented ones.
 *
 * What this API is: the cheapest tickets other travellers found on Aviasales in the last ~48 hours
 * (a cache, not a live search). So a fare here is real but may have moved, a route nobody searched
 * returns nothing (callers fall back to the sample data), and the payload is thin: price, airline,
 * ONE flight number, departure time, stop count and duration. There are no layover airports, no
 * per-flight breakdown and no baggage. Everything that is not in the payload is derived or left
 * empty; nothing is invented and shown as data (the layover/in-flight split is an estimate and only
 * feeds the Smart Score).
 */

const API = 'https://api.travelpayouts.com';
const TIMEOUT_MS = 7000;
/** Accept a cached fare this many days either side of the leg date when the exact date has none. */
const DATE_TOLERANCE_DAYS = 3;
const MAX_OPTIONS = 6;

export const travelpayoutsToken = (): string | undefined => getEnv('TRAVELPAYOUTS_TOKEN');
const marker = (): string | undefined => getEnv('TRAVELPAYOUTS_MARKER');

// ── Reference data (airline names, airport time zones): public files, loaded once ────────────────

interface Reference {
  airlines: Map<string, string>;
  zones: Map<string, string>;
}

let referencePromise: Promise<Reference | null> | null = null;
let referenceFailedAt = 0;

async function loadReference(): Promise<Reference | null> {
  if (referencePromise) return referencePromise;
  if (Date.now() - referenceFailedAt < 60_000) return null;
  referencePromise = (async () => {
    try {
      const [airlinesRes, airportsRes] = await Promise.all([
        fetch(`${API}/data/en/airlines.json`, { signal: AbortSignal.timeout(15_000) }),
        fetch(`${API}/data/en/airports.json`, { signal: AbortSignal.timeout(20_000) }),
      ]);
      if (!airlinesRes.ok || !airportsRes.ok) throw new Error(`HTTP ${airlinesRes.status}/${airportsRes.status}`);
      const airlines = new Map<string, string>();
      for (const a of (await airlinesRes.json()) as { code?: string; name?: string }[]) {
        if (a.code && a.name) airlines.set(a.code.toUpperCase(), a.name);
      }
      const zones = new Map<string, string>();
      for (const a of (await airportsRes.json()) as { code?: string; time_zone?: string; iata_type?: string }[]) {
        if (a.code && a.time_zone && (a.iata_type === 'airport' || !zones.has(a.code))) zones.set(a.code.toUpperCase(), a.time_zone);
      }
      return { airlines, zones };
    } catch (err) {
      console.warn('[Travelpayouts] Could not load airline/airport reference data:', err);
      referenceFailedAt = Date.now();
      referencePromise = null;
      return null;
    }
  })();
  return referencePromise;
}

// ── Aviasales response ───────────────────────────────────────────────────────────────────────────

interface TpTicket {
  origin?: string;
  destination?: string;
  origin_airport?: string;
  destination_airport?: string;
  price?: number;
  airline?: string;
  flight_number?: string | number;
  departure_at?: string;
  return_at?: string;
  transfers?: number;
  duration?: number;
  duration_to?: number;
  link?: string;
}

async function requestTickets(
  token: string,
  query: Record<string, string>
): Promise<TpTicket[] | null> {
  const url = new URL(`${API}/aviasales/v3/prices_for_dates`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  try {
    const res = await fetch(url.toString(), {
      headers: { 'X-Access-Token': token, 'Accept-Encoding': 'gzip, deflate' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[Travelpayouts] Data API returned ${res.status} ${res.statusText}`);
      if (res.status === 401 || res.status === 403) {
        console.warn('[env] TRAVELPAYOUTS_TOKEN was rejected by Travelpayouts (401/403). Check the token in .env.local.');
      }
      return null;
    }
    const body = (await res.json()) as { success?: boolean; data?: TpTicket[] };
    return body.success && Array.isArray(body.data) ? body.data : [];
  } catch (err) {
    console.warn('[Travelpayouts] Data API request failed or timed out:', err);
    return null;
  }
}

const dayOf = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

/** `HH:MM` and `YYYY-MM-DD` of an instant in a time zone. */
function inZone(ms: number, timeZone: string): { date: string; clock: string } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(ms));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return { date: `${get('year')}-${get('month')}-${get('day')}`, clock: `${get('hour')}:${get('minute')}` };
  } catch {
    return null;
  }
}

export interface TravelpayoutsQuery {
  origin: string;
  destination: string;
  /** Leg date, `YYYY-MM-DD`. */
  date: string;
  /** Round-trip prices (total for both directions) instead of one-way. */
  returnDate?: string;
  legId: string;
  hourlyRateUsd: number;
  activeVouchers: Voucher[];
  profile?: Partial<TravelerProfile>;
}

/**
 * Real recent fares for one corridor as ready-to-score flight options (`dataSource: 'cached'`), or
 * null when there is no token, the API fails, or it has nothing for this route and date.
 */
export async function fetchTravelpayoutsFlights(q: TravelpayoutsQuery): Promise<TransitOption[] | null> {
  const token = travelpayoutsToken();
  if (!token) {
    warnMissingKey('TRAVELPAYOUTS_TOKEN', 'recent real fares in sample mode');
    return null;
  }
  const origin = q.origin.trim().toUpperCase();
  const destination = q.destination.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination) || origin === destination) return null;

  const base: Record<string, string> = {
    origin,
    destination,
    currency: 'usd',
    sorting: 'price',
    unique: 'false',
    limit: '8',
    one_way: q.returnDate ? 'false' : 'true',
    ...(q.returnDate ? { return_at: q.returnDate } : {}),
  };

  // The cheapest fare overall and the cheapest non-stop: two different tickets worth showing
  const fetchBoth = async (departure: string) =>
    Promise.all([
      requestTickets(token, { ...base, departure_at: departure, direct: 'false' }),
      requestTickets(token, { ...base, departure_at: departure, direct: 'true' }),
    ]);

  console.log(`[Travelpayouts] ${origin} -> ${destination} on ${q.date}${q.returnDate ? ` (return ${q.returnDate})` : ''}`);
  let [anyStops, nonStop] = await fetchBoth(q.date);
  let tickets = [...(anyStops ?? []), ...(nonStop ?? [])];

  if (tickets.length === 0 && anyStops !== null) {
    // Nobody searched this exact day: take the nearest cached day of the month, if it is close
    [anyStops, nonStop] = await fetchBoth(q.date.slice(0, 7));
    const wanted = dayOf(q.date);
    tickets = [...(anyStops ?? []), ...(nonStop ?? [])].filter(
      (t) => t.departure_at && Math.abs(dayOf(t.departure_at) - wanted) <= DATE_TOLERANCE_DAYS * 86_400_000
    );
  }
  if (tickets.length === 0) {
    console.log('[Travelpayouts] No cached fares for this route/date, using sample data.');
    return null;
  }

  // One option per distinct flight + departure; cheapest first
  const seen = new Set<string>();
  const unique = tickets
    .filter((t) => Number(t.price) > 0 && t.departure_at && t.airline)
    .sort((a, b) => Number(a.price) - Number(b.price))
    .filter((t) => {
      const key = `${t.airline}${t.flight_number}|${t.departure_at}|${t.return_at ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_OPTIONS);

  const reference = await loadReference();
  const options: TransitOption[] = [];
  unique.forEach((t, idx) => {
    const option = toOption(t, idx, q, reference);
    if (option) options.push(option);
  });
  if (options.length === 0) return null;
  console.log(`[Travelpayouts] Built ${options.length} recent-fare option(s).`);
  return options;
}

function toOption(
  t: TpTicket,
  idx: number,
  q: TravelpayoutsQuery,
  reference: Reference | null
): TransitOption | null {
  const priceUsd = round2(Number(t.price));
  const airlineCode = String(t.airline ?? '').toUpperCase();
  const fromAp = resolveAirport(t.origin_airport || t.origin || q.origin);
  const toAp = resolveAirport(t.destination_airport || t.destination || q.destination);
  const totalMinutes = Number(t.duration_to) || (q.returnDate ? 0 : Number(t.duration)) || 0;
  if (!(priceUsd > 0) || !airlineCode || !fromAp || !toAp || !(totalMinutes > 0) || !t.departure_at) return null;

  // Departure is local time at the origin ("2026-11-26T08:40:00+03:00"): read it as written
  const dep = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(t.departure_at);
  if (!dep) return null;
  const departureMs = Date.parse(t.departure_at);
  const depStamp = `${dep[1]} ${dep[2]}`;

  // Arrival is local time at the destination: needs its time zone; without one it is left blank
  const zone = reference?.zones.get(toAp.code);
  const arrival = zone && Number.isFinite(departureMs) ? inZone(departureMs + totalMinutes * 60_000, zone) : null;
  const dayOffset = arrival ? Math.round((dayOf(arrival.date) - dayOf(dep[1])) / 86_400_000) : 0;
  const arrTime = arrival ? `${arrival.clock}${dayOffset > 0 ? ` +${dayOffset}d` : ''}` : '';

  const stops = Math.max(0, Number(t.transfers) || 0);
  const totalHours = totalMinutes / 60;
  // The API gives one duration. For a connection, split it into flying time (from the distance) and
  // waiting time so the Smart Score can weigh them; this split is an estimate, not provider data.
  let inVehicleHours = totalHours;
  let layoverHours = 0;
  if (stops > 0) {
    const km = haversineDistanceKm(fromAp.lat, fromAp.lng, toAp.lat, toAp.lng);
    const flying = Math.min(totalHours - 0.5 * stops, (km / 820 + 0.6) * 1.12);
    inVehicleHours = Math.max(totalHours * 0.4, flying);
    layoverHours = Math.max(0, totalHours - inVehicleHours);
  }
  inVehicleHours = round2(inVehicleHours);
  layoverHours = round2(layoverHours);

  const flightNumber = `${airlineCode} ${String(t.flight_number ?? '').trim()}`.trim();
  const carrier = reference?.airlines.get(airlineCode) ?? airlineCode;
  const returnDate = q.returnDate && t.return_at ? t.return_at.slice(0, 10) : q.returnDate;

  const segments: TransitSegment[] = [
    {
      id: `${q.legId}-tp-${idx + 1}-s1`,
      mode: 'flight' as TransitMode,
      label: flightNumber,
      fromName: fromAp.name,
      fromCode: fromAp.code,
      fromLat: fromAp.lat,
      fromLng: fromAp.lng,
      toName: toAp.name,
      toCode: toAp.code,
      toLat: toAp.lat,
      toLng: toAp.lng,
      durationMinutes: Math.round(inVehicleHours * 60),
    },
  ];
  // A non-stop ticket is one flight, which the payload fully describes; for a connection it is not
  // (only the first flight number is given), so no flight-by-flight list is shown.
  const hops: FlightHop[] =
    stops === 0 && arrival
      ? [
          {
            flightNumber,
            airline: carrier,
            fromCode: fromAp.code,
            fromName: fromAp.name,
            departureAt: depStamp,
            toCode: toAp.code,
            toName: toAp.name,
            arrivalAt: `${arrival.date} ${arrival.clock}`,
            durationMinutes: totalMinutes,
          },
        ]
      : [];

  const eligibleVouchers = VOUCHERS_CATALOG.filter(
    (v) =>
      v.applicableModes.includes('flight') &&
      priceUsd >= v.minSpendUsd &&
      (!v.applicableCarriers || v.applicableCarriers.length === 0 || v.applicableCarriers.includes(airlineCode))
  ).map((v) => v.id);

  const scorable = {
    ticketType: q.returnDate ? ('return' as const) : undefined,
    departureTime: dep[2],
    arrivalTime: arrTime,
    stopsCount: stops,
    segments,
    basePriceUsd: priceUsd,
    inVehicleHours,
    layoverHours,
    isOvernightSleeper: false,
    mode: 'flight' as TransitMode,
    carrierCode: airlineCode,
    eligibleVoucherIds: eligibleVouchers,
  };
  const breakdown = computeSmartScore(scorable, q.hourlyRateUsd, null, q.profile);
  const km = haversineDistanceKm(fromAp.lat, fromAp.lng, toAp.lat, toAp.lng);

  const sourcePath = t.link ? (t.link.startsWith('/') ? t.link : `/${t.link}`) : null;
  const sourceFareUrl = sourcePath
    ? `https://www.aviasales.com${sourcePath}${marker() ? `${sourcePath.includes('?') ? '&' : '?'}marker=${encodeURIComponent(marker()!)}` : ''}`
    : undefined;

  return {
    id: `${q.legId}-tp${q.returnDate ? '-rt' : ''}-${idx + 1}`,
    legId: q.legId,
    mode: 'flight',
    isOvernightSleeper: false,
    carrier,
    carrierCode: airlineCode,
    routeCode: flightNumber,
    flightNumbers: [flightNumber],
    carriers: [carrier],
    originStation: fromAp.name,
    destinationStation: toAp.name,
    departureTime: dep[2],
    arrivalTime: arrTime,
    departureAt: depStamp,
    arrivalAt: arrival ? `${arrival.date} ${arrival.clock}` : undefined,
    inVehicleHours,
    layoverHours,
    stopsCount: stops,
    basePriceUsd: priceUsd,
    discountedPriceUsd: breakdown.discountedPriceUsd,
    smartScore: breakdown.totalSmartScore,
    smartScoreBreakdown: breakdown,
    doorToDoorNotes: `${fromAp.code} (${dep[2]}) → ${toAp.code} (${arrTime || '--:--'})`,
    co2Kg: Math.round(km * 0.12),
    eligibleVoucherIds: eligibleVouchers,
    appliedVoucherId: null,
    segments,
    dataSource: 'cached',
    sourceFareUrl,
    ticketType: q.returnDate ? 'return' : undefined,
    returnDate,
    hops,
    layovers: [],
  } as TransitOption;
}
