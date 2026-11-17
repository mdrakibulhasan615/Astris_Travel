import { FALLBACK_RATES } from './currency.ts';

/**
 * Server-side fare pricing. Duffel's own fee ($3 + 1% per order) and card processing (~2.9% + $0.30)
 * come out of the margin, so a raw Duffel `total_amount` is never shown as the final price. Two tiers,
 * chosen by what the fare is worth in US dollars (so MYR, EUR and the rest are tiered the same way):
 *
 *   below the threshold   a flat service fee (default $10), so cheap tickets stay profitable
 *   at or above it        a percentage on top of the base fare (default 4.5%)
 *
 * Pure functions, no I/O: the exchange rates are passed in.
 */

export interface MarkupConfig {
  /** Fares worth less than this (USD equivalent) get the flat fee; the rest get the percentage. */
  thresholdUsd: number;
  /** Flat service fee in USD for fares under the threshold. Converted into the fare's currency. */
  shortHaulFlatFeeUsd: number;
  /** Percentage added to fares at or above the threshold (4.5 means 4.5%). */
  longHaulMarkupPercent: number;
}

export const DEFAULT_MARKUP_CONFIG: MarkupConfig = {
  thresholdUsd: 150,
  shortHaulFlatFeeUsd: 10,
  longHaulMarkupPercent: 4.5,
};

/** What the traveller is shown: the airline's fare, our fee, and the sum. All in `currency`. */
export interface PriceBreakdown {
  baseFare: number;
  serviceFee: number;
  displayTotal: number;
  currency: string;
  /** Which rule produced the fee. */
  tier: 'flat' | 'percent';
}

/** Currencies that have no minor unit: their amounts are whole numbers. */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'XAF', 'XOF', 'XPF', 'PYG', 'RWF']);

export function currencyDecimals(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

/** Rounds to the currency's minor unit (half away from zero, immune to binary-float drift). */
export function roundMoney(amount: number, currency: string): number {
  const f = 10 ** currencyDecimals(currency);
  return Math.round((amount + Math.sign(amount) * Number.EPSILON) * f) / f;
}

/** Units of `currency` per 1 USD, or null when no rate is known. */
export function unitsPerUsd(currency: string, rates: Record<string, number> = FALLBACK_RATES): number | null {
  const code = currency.toUpperCase();
  if (code === 'USD') return 1;
  const rate = rates[code];
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Converts an amount in `currency` to USD; null when the currency has no known rate. */
export function toUsd(amount: number, currency: string, rates: Record<string, number> = FALLBACK_RATES): number | null {
  const rate = unitsPerUsd(currency, rates);
  return rate === null ? null : amount / rate;
}

export class PricingError extends Error {}

/**
 * Adds our service fee to an airline fare.
 *
 * @throws PricingError for a negative / non-finite amount or a currency with no exchange rate (the
 *   tier cannot be decided without one, and guessing would mis-price the ticket).
 */
export function applyDynamicMarkup(
  baseAmount: number,
  currency: string,
  config: MarkupConfig = DEFAULT_MARKUP_CONFIG,
  rates: Record<string, number> = FALLBACK_RATES
): PriceBreakdown {
  if (!Number.isFinite(baseAmount) || baseAmount < 0) {
    throw new PricingError(`Invalid fare amount: ${baseAmount}`);
  }
  const code = (currency || '').trim().toUpperCase();
  const rate = unitsPerUsd(code, rates);
  if (!/^[A-Z]{3}$/.test(code) || rate === null) {
    throw new PricingError(`No exchange rate for currency "${currency}"`);
  }

  const baseFare = roundMoney(baseAmount, code);
  const usdEquivalent = baseFare / rate;
  const flat = usdEquivalent < config.thresholdUsd;
  const serviceFee = roundMoney(
    flat ? config.shortHaulFlatFeeUsd * rate : baseFare * (config.longHaulMarkupPercent / 100),
    code
  );
  return {
    baseFare,
    serviceFee,
    displayTotal: roundMoney(baseFare + serviceFee, code),
    currency: code,
    tier: flat ? 'flat' : 'percent',
  };
}
