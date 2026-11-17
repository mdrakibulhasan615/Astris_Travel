import type {
  BagStatus,
  BaggageInfo,
  FlightHop,
  Layover,
  TransitOption,
} from './types.ts';

/**
 * What a ticket card needs beyond price and times: the baggage allowance and the flight-by-flight
 * breakdown. Live fares fill these from the provider payload; a recent fare (thin payload) gets the
 * breakdown derived here from its own times, so the UI has one shape to render.
 */

// ── Baggage ──────────────────────────────────────────────────────────────────────────────────

const kgIn = (text: string) => {
  const m = /(\d{1,2})\s?kg/i.exec(text);
  return m ? Number(m[1]) : undefined;
};

/**
 * Reads baggage from the free-text amenity strings a fare carries ("Carry-on bag included",
 * "1st checked bag included", "Checked baggage for a fee", "No checked baggage"…). Returns null when
 * none of them mentions baggage, which is common: many fares report nothing.
 */
export function parseBaggage(texts: string[]): BaggageInfo | null {
  let cabin: BagStatus = 'unknown';
  let checked: BagStatus = 'unknown';
  let cabinKg: number | undefined;
  let checkedKg: number | undefined;
  let checkedPieces: number | undefined;

  for (const raw of texts) {
    const t = raw.trim();
    if (/carry-?on|cabin bag|hand bag|hand baggage/i.test(t)) {
      if (/\b(included|free)\b/i.test(t) && !/not included/i.test(t)) cabin = 'included';
      else if (/fee|extra|charge|not included/i.test(t)) cabin = 'fee';
      else if (/\b(no|without)\b/i.test(t)) cabin = 'none';
      cabinKg = cabinKg ?? kgIn(t);
    }
    if (/checked|hold bag|baggage allowance/i.test(t)) {
      const pieces = /(\d)(?:st|nd|rd|th)?\s+checked\s+bags?/i.exec(t);
      if (/\b(included|free)\b/i.test(t) && !/not included/i.test(t)) {
        checked = 'included';
        checkedPieces = pieces ? Number(pieces[1]) : (checkedPieces ?? 1);
      } else if (/fee|extra|charge|not included/i.test(t)) checked = 'fee';
      else if (/\b(no|without)\b/i.test(t)) checked = 'none';
      checkedKg = checkedKg ?? kgIn(t);
    }
  }
  if (cabin === 'unknown' && checked === 'unknown') return null;
  return { cabin, checked, cabinKg, checkedPieces, checkedKg, source: 'provider' };
}

/** Plain-language lines for a card, plus the tone to colour them with. */
export function describeBaggage(b: BaggageInfo): {
  cabin: { text: string; tone: 'good' | 'warn' | 'muted' };
  checked: { text: string; tone: 'good' | 'warn' | 'muted' };
} {
  const kg = (n?: number) => (n ? ` (${n} kg)` : '');
  const cabin =
    b.cabin === 'included'
      ? { text: `Carry-on included${kg(b.cabinKg)}`, tone: 'good' as const }
      : b.cabin === 'fee'
        ? { text: 'Carry-on for a fee', tone: 'warn' as const }
        : b.cabin === 'none'
          ? { text: 'No carry-on', tone: 'warn' as const }
          : { text: 'Carry-on: not stated', tone: 'muted' as const };
  const checked =
    b.checked === 'included'
      ? {
          text: b.checkedPieces
            ? `Checked bag: ${b.checkedPieces} × ${b.checkedKg ? `${b.checkedKg} kg` : 'piece'} included`
            : `Checked bag included${kg(b.checkedKg)}`,
          tone: 'good' as const,
        }
      : b.checked === 'fee'
        ? { text: 'Checked bag for a fee', tone: 'warn' as const }
        : b.checked === 'none'
          ? { text: 'No checked bag', tone: 'warn' as const }
          : { text: 'Checked bag: not stated', tone: 'muted' as const };
  return { cabin, checked };
}

/** Short wording for the boarding-pass stub: `Cabin: 7 kg included`, `Checked: 23 kg included`, `No checked bag`. */
export function describeBaggageStub(b: BaggageInfo): {
  cabin: { text: string; tone: 'good' | 'warn' | 'muted' };
  checked: { text: string; tone: 'good' | 'warn' | 'muted' };
} {
  const cabin =
    b.cabin === 'included'
      ? { text: b.cabinKg ? `Cabin: ${b.cabinKg} kg included` : 'Cabin: included', tone: 'good' as const }
      : b.cabin === 'fee'
        ? { text: 'Cabin: for a fee', tone: 'warn' as const }
        : b.cabin === 'none'
          ? { text: 'No cabin bag', tone: 'warn' as const }
          : { text: 'Cabin: not stated', tone: 'muted' as const };
  const checked =
    b.checked === 'included'
      ? {
          text:
            b.checkedPieces && b.checkedPieces > 1 && b.checkedKg
              ? `Checked: ${b.checkedPieces} × ${b.checkedKg} kg included`
              : b.checkedKg
                ? `Checked: ${b.checkedKg} kg included`
                : 'Checked: included',
          tone: 'good' as const,
        }
      : b.checked === 'fee'
        ? { text: 'Checked: for a fee', tone: 'warn' as const }
        : b.checked === 'none'
          ? { text: 'No checked bag', tone: 'warn' as const }
          : { text: 'Checked: not stated', tone: 'muted' as const };
  return { cabin, checked };
}

// ── Flight-by-flight breakdown ───────────────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD HH:MM` plus minutes (calendar-safe, no time zones: these are local clock times). */
function addMinutes(stamp: string, minutes: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(stamp);
  if (!m) return stamp;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + minutes * 60_000);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  );
}

/**
 * Per-flight breakdown for options that do not carry one (recent fares), built from
 * the option's flight segments so the card shows the same "flight number, airports, times,
 * layovers" lines as a live fare. The first departure is the option's own departure time; the last
 * arrival is its arrival time (with its `+Nd` day offset); times in between follow the segment
 * durations and an even split of the layover time.
 */
function deriveFlightDetails(
  option: TransitOption,
  date: string
): { hops: FlightHop[]; layovers: Layover[] } | null {
  const flights = (option.segments ?? []).filter((s) => s.mode === 'flight');
  const dep = /^(\d{1,2}):(\d{2})/.exec(option.departureTime ?? '');
  if (flights.length === 0 || !dep || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const numbers = (option.flightNumbers?.length
    ? option.flightNumbers
    : (option.routeCode ?? '').split(/\s*(?:\/|\+|,)\s*/)
  ).filter(Boolean);
  const layoverMinutes = flights.length > 1 ? (option.layoverHours * 60) / (flights.length - 1) : 0;

  let cursor = `${date} ${pad2(+dep[1])}:${dep[2]}`;
  const hops: FlightHop[] = [];
  const layovers: Layover[] = [];
  flights.forEach((seg, i) => {
    const label = /^[A-Z0-9]{2}\s?\d{1,4}$/.test(seg.label.trim()) ? seg.label.trim() : undefined;
    const arrival = addMinutes(cursor, seg.durationMinutes);
    hops.push({
      flightNumber: label ?? numbers[i] ?? option.routeCode,
      airline: option.carrier,
      fromCode: seg.fromCode,
      fromName: seg.fromName,
      departureAt: cursor,
      toCode: seg.toCode,
      toName: seg.toName,
      arrivalAt: arrival,
      durationMinutes: seg.durationMinutes,
    });
    if (i < flights.length - 1) {
      layovers.push({ code: seg.toCode, name: seg.toName, minutes: Math.round(layoverMinutes) });
      cursor = addMinutes(arrival, Math.round(layoverMinutes));
    }
  });

  // The option states its own arrival (with a day offset): the last hop must agree with it
  const arr = /^(\d{1,2}):(\d{2})(?:\s*\+(\d)d)?/.exec(option.arrivalTime ?? '');
  if (arr) {
    const arrivalDay = addMinutes(`${date} 00:00`, Number(arr[3] ?? 0) * 1440).slice(0, 10);
    hops[hops.length - 1].arrivalAt = `${arrivalDay} ${pad2(+arr[1])}:${arr[2]}`;
  }
  return { hops, layovers };
}

/**
 * Fills in what an option lacks so every card renders from one shape: a flight breakdown (built from
 * the option's own times and durations) when the fare did not carry one. Baggage is never guessed: it is
 * shown only when the fare states it. Never overwrites provider data. `date` is the leg's departure date (`YYYY-MM-DD`).
 */
export function completeTicketDetails(option: TransitOption, date?: string): TransitOption {
  let out = option;
  if (!out.hops && out.mode === 'flight' && date) {
    const derived = deriveFlightDetails(out, date.slice(0, 10));
    if (derived) out = { ...out, hops: derived.hops, layovers: out.layovers ?? derived.layovers };
  }
  return out;
}
