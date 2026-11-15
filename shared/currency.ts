/**
 * Display currency. Every price in the app is computed and ranked in USD (fares, vouchers, the
 * Smart Score); the currency switcher only changes how an amount is shown, so switching never
 * re-queries fares or changes a ranking. Rates come from `GET /api/rates` (ECB reference rates via
 * Frankfurter, cached on the server); the table below is the fallback when they cannot be fetched.
 */

export const CURRENCIES = [
  { code: 'USD', name: 'US dollar' },
  { code: 'MYR', name: 'Malaysian ringgit' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'British pound' },
  { code: 'TRY', name: 'Turkish lira' },
  { code: 'JPY', name: 'Japanese yen' },
  { code: 'SGD', name: 'Singapore dollar' },
] as const;

export type CurrencyCode = (typeof CURRENCIES)[number]['code'];

export const DEFAULT_CURRENCY: CurrencyCode = 'USD';

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return CURRENCIES.some((c) => c.code === value);
}

/** Units of each currency per 1 USD. Approximate (Nov 2026): used only when live rates are down. */
export const FALLBACK_RATES: Record<CurrencyCode, number> = {
  USD: 1,
  MYR: 4.09,
  EUR: 0.905,
  GBP: 0.756,
  TRY: 50.4,
  JPY: 160,
  SGD: 1.288,
};

export interface RatesPayload {
  base: 'USD';
  /** Units of each currency per 1 USD. */
  rates: Record<string, number>;
  /** Rate date (`YYYY-MM-DD`), or the fallback table's date. */
  asOf: string;
  source: 'live' | 'fallback';
}

export const FALLBACK_RATES_PAYLOAD: RatesPayload = {
  base: 'USD',
  rates: FALLBACK_RATES,
  asOf: '2026-11-13',
  source: 'fallback',
};

export function convertUsd(
  amountUsd: number,
  currency: CurrencyCode,
  rates: Record<string, number> = FALLBACK_RATES
): number {
  const rate = rates[currency];
  return amountUsd * (Number.isFinite(rate) && rate > 0 ? rate : FALLBACK_RATES[currency]);
}

const formatters = new Map<string, Intl.NumberFormat>();

/** `USD 100` → `$100`, `RM`-style ambiguity avoided by using ISO symbols (`MYR 409`, `₺5,040`). */
export function formatMoney(
  amountUsd: number,
  currency: CurrencyCode = DEFAULT_CURRENCY,
  rates: Record<string, number> = FALLBACK_RATES
): string {
  if (!Number.isFinite(amountUsd)) return '–';
  let fmt = formatters.get(currency);
  if (!fmt) {
    fmt = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    });
    formatters.set(currency, fmt);
  }
  return fmt.format(Math.round(convertUsd(amountUsd, currency, rates)));
}
