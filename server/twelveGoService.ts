import { getEnv } from './env.ts';
import { AFFILIATE_DEFAULTS } from '../shared/config.ts';
import { getJson, setJson } from './jsonCache.ts';
import type { TwelveGoClass, TwelveGoRoute } from '../shared/groundSchedule.ts';

/**
 * 12Go timetables for regional and intercity bus, train, ferry, van and taxi routes. 12Go publishes
 * an embeddable timetable page for partners (`/{lang}/timetable/{country}/{from}/{to}`); the server
 * fetches it, reads the routes out of the HTML (never passing the markup on to the browser) and
 * rebuilds each booking link with our partner id, the date and the party size.
 *
 * What the page gives: per route, the class (Express, VIP, Minivan…), the departure times, the
 * price and duration range. It does NOT name the operating company, so none is shown.
 */

const TIMEOUT_MS = 9000;

/** The countries 12Go's timetable widget documents. */
const COUNTRY_CODES: Record<string, string> = {
  thailand: 'TH',
  malaysia: 'MY',
  cambodia: 'KH',
  vietnam: 'VN',
  'viet nam': 'VN',
  singapore: 'SG',
};

export function twelveGoCountry(country: string | undefined): string | null {
  return COUNTRY_CODES[(country ?? '').trim().toLowerCase()] ?? null;
}

const partnerId = (): string => getEnv('TWELVEGO_AFFILIATE_ID') ?? AFFILIATE_DEFAULTS.twelveGoAffiliateId;

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const norm = (s: string) => slug(s).toLowerCase().replace(/-/g, ' ');

const decode = (s: string) =>
  s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&ndash;|&#8211;/g, '–')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/** `4h 44m`, `55m – 1days 9h 58m`: the shortest and longest, in minutes. */
export function parseDurationRange(text: string): { min?: number; max?: number } {
  const one = (part: string) => {
    const d = /(\d+)\s*days?/.exec(part)?.[1];
    const h = /(\d+)\s*h/.exec(part)?.[1];
    const m = /(\d+)\s*m/.exec(part)?.[1];
    if (!d && !h && !m) return undefined;
    return Number(d ?? 0) * 1440 + Number(h ?? 0) * 60 + Number(m ?? 0);
  };
  const parts = text.split(/–|-/).map(one).filter((n): n is number => n !== undefined);
  return parts.length ? { min: Math.min(...parts), max: Math.max(...parts) } : {};
}

/** `$ 7.97–11.04` in the currency asked for (USD). */
export function parsePriceRange(text: string): { min?: number; max?: number } {
  const nums = [...text.matchAll(/\d[\d,]*\.?\d*/g)].map((m) => Number(m[0].replace(/,/g, ''))).filter(Number.isFinite);
  return nums.length ? { min: Math.min(...nums), max: Math.max(...nums) } : {};
}

const MODE_FROM_PATH: Record<string, TwelveGoRoute['mode'] | 'flight'> = {
  bus: 'bus',
  train: 'train',
  ferry: 'ferry',
  van: 'van',
  charter: 'taxi',
  avia: 'flight',
};

export interface ParseContext {
  from: string;
  to: string;
  date?: string;
  people?: number;
}

/** Routes out of the timetable HTML. Exported for tests. */
export function parseTimetable(html: string, ctx: ParseContext): TwelveGoRoute[] {
  const wantFrom = norm(ctx.from);
  const wantTo = norm(ctx.to);
  const matches = (name: string, want: string) => {
    const n = norm(name);
    return n === want || n.includes(want) || want.includes(n);
  };

  const routes: TwelveGoRoute[] = [];
  for (const container of html.split('one2go-route-container').slice(1)) {
    const rows = container.split(/<tr[\s>]/i).slice(1);
    let current: Omit<TwelveGoRoute, 'classes'> | null = null;
    let classes: TwelveGoClass[] = [];
    const flush = () => {
      if (current && classes.length > 0) routes.push({ ...current, classes });
      current = null;
      classes = [];
    };

    for (const row of rows) {
      if (row.includes('one2go-route-name')) {
        flush();
        const anchor = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
        if (!anchor) continue;
        const url = decode(anchor[1]);
        const mode = MODE_FROM_PATH[/\/(?:[a-z]{2}\/)?(bus|train|ferry|van|charter|avia)\//i.exec(url)?.[1]?.toLowerCase() ?? ''];
        if (!mode || mode === 'flight') continue; // flights are the flight cards' job
        const label = decode(anchor[2]).replace(/^(Bus|Train|Ferry|Van|Taxi|Charter)\s+/i, '');
        const [from, to] = label.split(/\s+-\s+/);
        if (!from || !to) continue;
        const price = parsePriceRange(decode(/one2go-route-price[^>]*>([\s\S]*?)<\/span>/i.exec(row)?.[1] ?? ''));
        const duration = parseDurationRange(decode(/one2go-route-duration[^>]*>([\s\S]*?)<\/span>/i.exec(row)?.[1] ?? ''));
        current = {
          mode,
          from,
          to,
          exact: matches(from, wantFrom) && matches(to, wantTo),
          priceMinUsd: price.min,
          priceMaxUsd: price.max,
          durationMinMinutes: duration.min,
          durationMaxMinutes: duration.max,
          url: bookingUrl(url, ctx),
        };
      } else if (row.includes('one2go-trips') && current) {
        for (const li of row.split(/<li[\s>]/i).slice(1)) {
          const label = decode(/one2go-class[^>]*>([\s\S]*?)<\/span>/i.exec(li)?.[1] ?? '');
          if (!label) continue;
          const times = decode(/one2go-departures[^>]*>([\s\S]*?)<\/span>/i.exec(li)?.[1] ?? '')
            .split(/,\s*/)
            .filter((t) => /^\d{1,2}:\d{2}$/.test(t));
          classes.push({ label, departures: times });
        }
      }
    }
    flush();
  }
  // The requested pair first, then routes that share one end (e.g. Kuala Lumpur to Penang's mainland
  // terminal Butterworth), then the rest
  const rank = (r: TwelveGoRoute) =>
    r.exact ? 2 : matches(r.from, wantFrom) || matches(r.to, wantTo) ? 1 : 0;
  return routes.sort((a, b) => rank(b) - rank(a));
}

/** A 12Go URL with our partner id, the date and the party size. Anything not on 12Go is refused. */
function bookingUrl(raw: string, ctx: ParseContext): string {
  const url = new URL(raw, 'https://12go.asia');
  if (url.hostname !== '12go.asia' && !url.hostname.endsWith('.12go.asia')) return `https://12go.asia/en?z=${partnerId()}`;
  url.protocol = 'https:';
  url.searchParams.set('z', partnerId());
  url.searchParams.set('curr', 'USD');
  if (ctx.date && /^\d{4}-\d{2}-\d{2}$/.test(ctx.date)) url.searchParams.set('date', ctx.date);
  if (ctx.people && ctx.people > 0) url.searchParams.set('people', String(Math.min(9, Math.floor(ctx.people))));
  return url.toString();
}

export interface TwelveGoQuery {
  country: string;
  from: string;
  to: string;
  date?: string;
  people?: number;
}

/**
 * The timetable for a city pair, or null when 12Go has nothing. The cache holds the parsed routes
 * (7 days, keyed by country, origin, destination); the date and party size are applied to the links
 * on the way out so one cached timetable serves every date.
 */
export async function fetchTwelveGoTimetable(q: TwelveGoQuery): Promise<TwelveGoRoute[] | null> {
  const from = slug(q.from);
  const to = slug(q.to);
  if (!from || !to || from === to) return null;
  const ctx: ParseContext = { from: q.from, to: q.to, date: q.date, people: q.people };

  const cacheKey = `12go:timetable:${q.country}:${from.toLowerCase()}:${to.toLowerCase()}`;
  const cached = await getJson<TwelveGoRoute[]>(cacheKey);
  if (cached) return cached.length > 0 ? cached.map((r) => ({ ...r, url: bookingUrl(r.url, ctx) })) : null;

  const url = new URL(`https://12go.asia/en/timetable/${q.country}/${from}/${to}`);
  url.searchParams.set('embedded', '');
  url.searchParams.set('css', 'no');
  url.searchParams.set('z', partnerId());
  url.searchParams.set('noreturn', '');
  url.searchParams.set('currency', 'USD');
  try {
    console.log(`[12Go] timetable ${q.country} ${from} -> ${to}`);
    const res = await fetch(url.toString().replace(/embedded=&/, 'embedded&').replace(/noreturn=(&|$)/, 'noreturn$1'), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AstrisTravel/1.0)', Accept: 'text/html' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[12Go] timetable returned ${res.status}`);
      return null;
    }
    const routes = parseTimetable(await res.text(), ctx);
    await setJson(cacheKey, routes);
    return routes.length > 0 ? routes : null;
  } catch (err) {
    console.warn('[12Go] timetable request failed or timed out:', err);
    return null;
  }
}
