import type { TransitOption } from '../../shared/types.ts';

/**
 * Airline brand colours for the boarding-pass tickets.
 *
 * A ticket's header and accent strip use the brand colour of the airline that operates it; a
 * connection across several airlines uses a left-to-right gradient of their colours in flight
 * order. Text on the bar is chosen for contrast, so bright brands (Scoot yellow, Singapore gold)
 * get dark text and deep brands (Malaysia Airlines blue, Qatar burgundy) get white text.
 */

export const LIGHT_TEXT = '#FFFFFF';
export const DARK_TEXT = '#0F172A';
/** Used for any airline that is not in the table. */
export const FALLBACK_AIRLINE_COLOR = '#0284C7';

export interface AirlineBrand {
  /** Primary brand colour. */
  color: string;
  /** Contrasting text colour for use on `color`. */
  text: string;
  /** Secondary brand colour, where the brand has an established second colour. */
  alt?: string;
}

const light = LIGHT_TEXT;
const dark = DARK_TEXT;

/** IATA code → brand. */
const BRANDS_BY_CODE: Record<string, AirlineBrand> = {
  // Southeast Asia
  MH: { color: '#003B70', text: light }, // Malaysia Airlines
  AK: { color: '#FF0000', text: light }, // AirAsia
  D7: { color: '#FF0000', text: light }, // AirAsia X
  FD: { color: '#FF0000', text: light }, // Thai AirAsia
  QZ: { color: '#FF0000', text: light }, // Indonesia AirAsia
  OD: { color: '#5E2750', text: light }, // Batik Air
  SQ: { color: '#F5A623', text: dark, alt: '#1D4886' }, // Singapore Airlines
  TR: { color: '#FFE600', text: dark }, // Scoot
  TG: { color: '#512D6D', text: light }, // Thai Airways
  GA: { color: '#00529B', text: light }, // Garuda Indonesia
  VN: { color: '#1B6CA8', text: light }, // Vietnam Airlines
  PR: { color: '#1D4A9B', text: light }, // Philippine Airlines
  JQ: { color: '#FF5B00', text: dark }, // Jetstar
  // East Asia / Pacific
  CX: { color: '#006564', text: light }, // Cathay Pacific
  JL: { color: '#CC0000', text: light }, // Japan Airlines
  NH: { color: '#13448F', text: light }, // ANA
  KE: { color: '#00256C', text: light }, // Korean Air
  OZ: { color: '#C8102E', text: light }, // Asiana
  BR: { color: '#00793A', text: light }, // EVA Air
  CI: { color: '#C8102E', text: light }, // China Airlines
  CA: { color: '#D40E14', text: light }, // Air China
  MU: { color: '#003A8F', text: light }, // China Eastern
  CZ: { color: '#0066B3', text: light }, // China Southern
  QF: { color: '#E40000', text: light }, // Qantas
  // Middle East / Turkey
  QR: { color: '#5C0632', text: light }, // Qatar Airways
  EK: { color: '#D71921', text: light }, // Emirates
  EY: { color: '#BD8B13', text: dark }, // Etihad
  TK: { color: '#C70A0C', text: light }, // Turkish Airlines
  PC: { color: '#FFC20E', text: dark }, // Pegasus
  VF: { color: '#00A0D6', text: dark }, // AJet
  SV: { color: '#006C35', text: light }, // Saudia
  WY: { color: '#D2232A', text: light }, // Oman Air
  GF: { color: '#A5822D', text: dark }, // Gulf Air
  // Europe
  BA: { color: '#075AAA', text: light }, // British Airways
  LH: { color: '#05164D', text: light }, // Lufthansa
  AF: { color: '#002157', text: light }, // Air France
  KL: { color: '#00A1DE', text: dark }, // KLM
  LX: { color: '#E2001A', text: light }, // Swiss
  OS: { color: '#E00000', text: light }, // Austrian
  IB: { color: '#D7192D', text: light }, // Iberia
  TP: { color: '#00A859', text: dark }, // TAP Air Portugal
  AY: { color: '#0B1560', text: light }, // Finnair
  SK: { color: '#000E8C', text: light }, // SAS
  A3: { color: '#0E3A6D', text: light }, // Aegean
  U2: { color: '#FF6600', text: dark }, // easyJet
  FR: { color: '#073590', text: light }, // Ryanair
  W6: { color: '#C6007E', text: light }, // Wizz Air
  VY: { color: '#FFCC00', text: dark }, // Vueling
  EI: { color: '#00A651', text: dark }, // Aer Lingus
  // Americas / India
  DL: { color: '#003366', text: light }, // Delta
  UA: { color: '#0033A0', text: light }, // United
  AA: { color: '#0078D2', text: light }, // American
  AC: { color: '#F01428', text: light }, // Air Canada
  AI: { color: '#E31837', text: light }, // Air India
  '6E': { color: '#1B0088', text: light }, // IndiGo
  // This app's own sample airlines
  AS: { color: '#FF812E', text: dark }, // Astris Skyways (sample data)
};

/** Common airline names (lower-case, as providers print them) → IATA code. */
const CODES_BY_NAME: Record<string, string> = {
  'malaysia airlines': 'MH',
  airasia: 'AK',
  'airasia x': 'D7',
  'thai airasia': 'FD',
  'batik air': 'OD',
  'singapore airlines': 'SQ',
  scoot: 'TR',
  'thai airways': 'TG',
  'garuda indonesia': 'GA',
  'vietnam airlines': 'VN',
  'philippine airlines': 'PR',
  jetstar: 'JQ',
  'cathay pacific': 'CX',
  'japan airlines': 'JL',
  'all nippon airways': 'NH',
  ana: 'NH',
  'korean air': 'KE',
  'asiana airlines': 'OZ',
  'eva air': 'BR',
  'china airlines': 'CI',
  'air china': 'CA',
  'china eastern': 'MU',
  'china southern': 'CZ',
  qantas: 'QF',
  'qatar airways': 'QR',
  emirates: 'EK',
  'etihad airways': 'EY',
  etihad: 'EY',
  'turkish airlines': 'TK',
  pegasus: 'PC',
  'pegasus airlines': 'PC',
  ajet: 'VF',
  saudia: 'SV',
  'oman air': 'WY',
  'gulf air': 'GF',
  'british airways': 'BA',
  lufthansa: 'LH',
  'air france': 'AF',
  klm: 'KL',
  swiss: 'LX',
  'austrian airlines': 'OS',
  iberia: 'IB',
  'tap air portugal': 'TP',
  finnair: 'AY',
  'scandinavian airlines': 'SK',
  'aegean airlines': 'A3',
  aegean: 'A3',
  easyjet: 'U2',
  ryanair: 'FR',
  'wizz air': 'W6',
  vueling: 'VY',
  'aer lingus': 'EI',
  'delta air lines': 'DL',
  'united airlines': 'UA',
  'american airlines': 'AA',
  'air canada': 'AC',
  'air india': 'AI',
  indigo: '6E',
  'astris skyways': 'AS',
};

const FALLBACK: AirlineBrand = { color: FALLBACK_AIRLINE_COLOR, text: LIGHT_TEXT };

/** Brand for an airline by IATA code, else by name, else the fallback sky blue. */
export function getAirlineBrand(code?: string | null, name?: string | null): AirlineBrand {
  const byCode = code ? BRANDS_BY_CODE[code.trim().toUpperCase()] : undefined;
  if (byCode) return byCode;
  const n = (name ?? '').trim().toLowerCase();
  if (n) {
    const exact = CODES_BY_NAME[n];
    if (exact) return BRANDS_BY_CODE[exact];
    // "Turkish Airlines (Business)", "Malaysia Airlines Berhad": match on the longest known name inside
    const known = Object.keys(CODES_BY_NAME)
      .filter((k) => n.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    if (known) return BRANDS_BY_CODE[CODES_BY_NAME[known]];
  }
  return FALLBACK;
}

// ── Contrast ─────────────────────────────────────────────────────────────────────────────────

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG contrast ratio between two `#RRGGBB` colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** White text when it reads comfortably on the background, dark slate otherwise. */
export function readableText(background: string): string {
  return contrastRatio(background, LIGHT_TEXT) >= 3.2 ? LIGHT_TEXT : DARK_TEXT;
}

/** The brand colour as a colour for text and icons on a white surface (darkened if too pale). */
export function accentOnLight(color: string): string {
  let c = color;
  for (let i = 0; i < 8 && contrastRatio(c, '#FFFFFF') < 3; i++) c = mix(c, '#111827', 0.2);
  return c;
}

function mix(a: string, b: string, t: number): string {
  const p = (hex: string) => {
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const [ar, ag, ab] = p(a);
  const [br, bg, bb] = p(b);
  const to = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${to(ar, br)}${to(ag, bg)}${to(ab, bb)}`;
}

// ── Tickets ──────────────────────────────────────────────────────────────────────────────────

export interface TicketAirline {
  code?: string;
  name: string;
}

/**
 * The airlines that operate a ticket, each once, in the order their flights depart. Uses the
 * per-flight breakdown when there is one (so `MH` then `QR`), else the option's carriers.
 */
export function ticketAirlines(
  option: Pick<TransitOption, 'hops' | 'carriers' | 'carrier' | 'carrierCode'>
): TicketAirline[] {
  const out: TicketAirline[] = [];
  const add = (code: string | undefined, name: string | undefined) => {
    const c = code?.toUpperCase();
    const label = (name ?? '').trim();
    if (!c && !label) return;
    const known = getAirlineCodeFromName(label);
    const key = c ?? known ?? label.toLowerCase();
    if (out.some((a) => (a.code ?? getAirlineCodeFromName(a.name) ?? a.name.toLowerCase()) === key)) return;
    out.push({ code: c ?? known, name: label || c! });
  };

  if (option.hops?.length) {
    for (const hop of option.hops) {
      add(/^([A-Z0-9]{2})\s?\d/i.exec(hop.flightNumber)?.[1], hop.airline);
    }
  }
  if (out.length === 0) {
    if (option.carriers?.length) option.carriers.forEach((name) => add(undefined, name));
    else add(option.carrierCode, option.carrier);
  }
  return out;
}

function getAirlineCodeFromName(name: string): string | undefined {
  const n = name.trim().toLowerCase();
  if (!n) return undefined;
  if (CODES_BY_NAME[n]) return CODES_BY_NAME[n];
  const known = Object.keys(CODES_BY_NAME)
    .filter((k) => n.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  return known ? CODES_BY_NAME[known] : undefined;
}

export interface TicketPalette {
  /** CSS `background` for the header bar, accent strip and primary button: solid, or a gradient. */
  background: string;
  /** Text colour that stays readable across the whole bar. */
  text: string;
  /** Brand colour for icons and highlights on a white surface. */
  accent: string;
  /** Brand colours in flight order. */
  colors: string[];
  /** `MH × QR` style label of the operating airlines. */
  label: string;
  isMulti: boolean;
}

/**
 * Colours for one ticket. One airline: its brand colour. Several: a left-to-right gradient of their
 * colours in flight order (`linear-gradient(90deg, c1, c2, ...)`), with the text colour picked so it
 * is legible over every stop of the gradient.
 */
export function ticketPalette(airlines: TicketAirline[]): TicketPalette {
  const brands = (airlines.length ? airlines : [{ name: '' }]).map((a) => getAirlineBrand(a.code, a.name));
  const colors = brands.map((b) => b.color);
  const isMulti = colors.length > 1;

  let text: string;
  if (!isMulti) {
    text = brands[0].text;
  } else {
    const worst = (fg: string) => Math.min(...colors.map((c) => contrastRatio(c, fg)));
    text = worst(LIGHT_TEXT) >= 3.2 ? LIGHT_TEXT : worst(LIGHT_TEXT) >= worst(DARK_TEXT) ? LIGHT_TEXT : DARK_TEXT;
  }
  return {
    background: isMulti ? `linear-gradient(90deg, ${colors.join(', ')})` : colors[0],
    text,
    accent: accentOnLight(colors[0]),
    colors,
    label: airlines.map((a) => a.name).join(' × '),
    isMulti,
  };
}
