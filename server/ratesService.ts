import {
  CURRENCIES,
  FALLBACK_RATES_PAYLOAD,
  type RatesPayload,
} from '../shared/currency.ts';

/**
 * Exchange rates for the currency switcher: ECB reference rates (USD base) from Frankfurter, which is
 * free and needs no key. Cached in memory for 12 hours (per serverless instance); any failure serves
 * the built-in fallback table, flagged `source: 'fallback'`, and is retried after 10 minutes.
 */
const RATES_URL = 'https://api.frankfurter.dev/v1/latest';
const TTL_MS = 12 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;

let cached: { payload: RatesPayload; expires: number } | null = null;
let inFlight: Promise<RatesPayload> | null = null;

async function fetchRates(): Promise<RatesPayload> {
  try {
    const url = new URL(RATES_URL);
    url.searchParams.set('base', 'USD');
    url.searchParams.set(
      'symbols',
      CURRENCIES.map((c) => c.code)
        .filter((c) => c !== 'USD')
        .join(',')
    );
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { date?: string; rates?: Record<string, number> };
    const rates: Record<string, number> = { USD: 1 };
    for (const { code } of CURRENCIES) {
      const rate = Number(data.rates?.[code]);
      if (code !== 'USD') {
        if (!(rate > 0)) throw new Error(`no rate for ${code}`);
        rates[code] = rate;
      }
    }
    cached = {
      payload: { base: 'USD', rates, asOf: data.date ?? new Date().toISOString().slice(0, 10), source: 'live' },
      expires: Date.now() + TTL_MS,
    };
  } catch (err) {
    console.warn('[Rates] live exchange rates unavailable, using the fallback table:', (err as Error)?.message ?? err);
    cached = { payload: FALLBACK_RATES_PAYLOAD, expires: Date.now() + RETRY_MS };
  }
  return cached.payload;
}

export async function getRates(): Promise<RatesPayload> {
  if (cached && cached.expires > Date.now()) return cached.payload;
  inFlight ??= fetchRates().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
