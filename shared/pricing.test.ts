import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_MARKUP_CONFIG,
  PricingError,
  applyDynamicMarkup,
  currencyDecimals,
  roundMoney,
  toUsd,
} from './pricing.ts';

// Units per 1 USD, fixed so the tests do not depend on the fallback table
const RATES = { USD: 1, MYR: 4, EUR: 0.9, JPY: 150, GBP: 0.8 };

describe('applyDynamicMarkup: USD', () => {
  it('adds the flat $10 fee under $150', () => {
    const p = applyDynamicMarkup(100, 'USD', DEFAULT_MARKUP_CONFIG, RATES);
    assert.deepEqual(p, { baseFare: 100, serviceFee: 10, displayTotal: 110, currency: 'USD', tier: 'flat' });
  });

  it('adds the flat fee at $149.99 (just under the threshold)', () => {
    const p = applyDynamicMarkup(149.99, 'USD', DEFAULT_MARKUP_CONFIG, RATES);
    assert.equal(p.tier, 'flat');
    assert.equal(p.serviceFee, 10);
    assert.equal(p.displayTotal, 159.99);
  });

  it('switches to 4.5% at exactly $150', () => {
    const p = applyDynamicMarkup(150, 'USD', DEFAULT_MARKUP_CONFIG, RATES);
    assert.equal(p.tier, 'percent');
    assert.equal(p.serviceFee, 6.75);
    assert.equal(p.displayTotal, 156.75);
  });

  it('adds 4.5% on a long-haul fare', () => {
    const p = applyDynamicMarkup(600, 'USD', DEFAULT_MARKUP_CONFIG, RATES);
    assert.equal(p.serviceFee, 27);
    assert.equal(p.displayTotal, 627);
  });

  it('displayTotal is always baseFare + serviceFee', () => {
    for (const amount of [0, 0.01, 12.34, 149.99, 150, 333.33, 1999.99]) {
      const p = applyDynamicMarkup(amount, 'USD', DEFAULT_MARKUP_CONFIG, RATES);
      assert.equal(p.displayTotal, roundMoney(p.baseFare + p.serviceFee, 'USD'));
    }
  });
});

describe('applyDynamicMarkup: other currencies are tiered by their USD value', () => {
  it('MYR 500 is $125, so it gets the flat fee, converted into ringgit', () => {
    const p = applyDynamicMarkup(500, 'MYR', DEFAULT_MARKUP_CONFIG, RATES);
    assert.equal(p.tier, 'flat');
    assert.equal(p.serviceFee, 40); // $10 at 4 MYR per USD
    assert.equal(p.displayTotal, 540);
    assert.equal(p.currency, 'MYR');
  });

  it('MYR 600 is exactly $150, so it gets the percentage', () => {
    const p = applyDynamicMarkup(600, 'MYR', DEFAULT_MARKUP_CONFIG, RATES);
    assert.equal(p.tier, 'percent');
    assert.equal(p.serviceFee, 27);
    assert.equal(p.displayTotal, 627);
  });

  it('MYR 2660 (a long-haul fare) gets 4.5%', () => {
    const p = applyDynamicMarkup(2660, 'MYR', DEFAULT_MARKUP_CONFIG, RATES);
    assert.equal(p.serviceFee, 119.7);
    assert.equal(p.displayTotal, 2779.7);
  });

  it('EUR 120 is about $133, flat; EUR 140 is about $155, percent', () => {
    assert.equal(applyDynamicMarkup(120, 'EUR', DEFAULT_MARKUP_CONFIG, RATES).tier, 'flat');
    assert.equal(applyDynamicMarkup(140, 'EUR', DEFAULT_MARKUP_CONFIG, RATES).tier, 'percent');
    assert.equal(applyDynamicMarkup(120, 'EUR', DEFAULT_MARKUP_CONFIG, RATES).serviceFee, 9); // $10 * 0.9
  });

  it('is case-insensitive about the currency code', () => {
    assert.equal(applyDynamicMarkup(100, 'myr', DEFAULT_MARKUP_CONFIG, RATES).currency, 'MYR');
  });

  it('rounds zero-decimal currencies to whole numbers', () => {
    assert.equal(currencyDecimals('JPY'), 0);
    const p = applyDynamicMarkup(12000, 'JPY', DEFAULT_MARKUP_CONFIG, RATES); // $80: flat
    assert.equal(p.tier, 'flat');
    assert.equal(p.serviceFee, 1500); // $10 * 150
    assert.equal(p.displayTotal, 13500);
    assert.ok(Number.isInteger(p.serviceFee) && Number.isInteger(p.displayTotal));
    const big = applyDynamicMarkup(123457, 'JPY', DEFAULT_MARKUP_CONFIG, RATES); // percent
    assert.ok(Number.isInteger(big.serviceFee));
  });
});

describe('applyDynamicMarkup: configuration and errors', () => {
  it('honours a custom flat fee, percentage and threshold', () => {
    const cfg = { thresholdUsd: 200, shortHaulFlatFeeUsd: 15, longHaulMarkupPercent: 6 };
    assert.equal(applyDynamicMarkup(180, 'USD', cfg, RATES).serviceFee, 15);
    assert.equal(applyDynamicMarkup(200, 'USD', cfg, RATES).serviceFee, 12);
  });

  it('rounds the percentage fee to cents', () => {
    const p = applyDynamicMarkup(155.55, 'USD', DEFAULT_MARKUP_CONFIG, RATES); // 7.00 (7.00 exactly: 6.99975)
    assert.equal(p.serviceFee, 7);
    const q = applyDynamicMarkup(199.99, 'USD', DEFAULT_MARKUP_CONFIG, RATES); // 8.99955
    assert.equal(q.serviceFee, 9);
  });

  it('throws for a currency without an exchange rate', () => {
    assert.throws(() => applyDynamicMarkup(100, 'XYZ', DEFAULT_MARKUP_CONFIG, RATES), PricingError);
    assert.throws(() => applyDynamicMarkup(100, 'US', DEFAULT_MARKUP_CONFIG, RATES), PricingError);
  });

  it('throws for a negative or non-finite amount', () => {
    assert.throws(() => applyDynamicMarkup(-1, 'USD', DEFAULT_MARKUP_CONFIG, RATES), PricingError);
    assert.throws(() => applyDynamicMarkup(Number.NaN, 'USD', DEFAULT_MARKUP_CONFIG, RATES), PricingError);
    assert.throws(() => applyDynamicMarkup(Infinity, 'USD', DEFAULT_MARKUP_CONFIG, RATES), PricingError);
  });

  it('toUsd converts and reports unknown currencies as null', () => {
    assert.equal(toUsd(400, 'MYR', RATES), 100);
    assert.equal(toUsd(5, 'USD', RATES), 5);
    assert.equal(toUsd(5, 'XYZ', RATES), null);
  });
});
