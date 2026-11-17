import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  MIN_OFFER_LIFETIME_MS,
  normalizeOffer,
  offerCacheKey,
  parseIsoDuration,
  stillBookable,
  validateSearch,
} from './duffelService.ts';
import { findReference, verifyDuffelSignature } from './duffelBookings.ts';

describe('parseIsoDuration', () => {
  it('reads hours and minutes', () => {
    assert.equal(parseIsoDuration('PT20H10M'), 1210);
    assert.equal(parseIsoDuration('PT45M'), 45);
    assert.equal(parseIsoDuration('PT3H'), 180);
  });
  it('reads days and ignores junk', () => {
    assert.equal(parseIsoDuration('P1DT2H'), 26 * 60);
    assert.equal(parseIsoDuration('nope'), 0);
    assert.equal(parseIsoDuration(null), 0);
  });
});

describe('offer cache lifetime', () => {
  const now = Date.parse('2026-11-21T10:00:00Z');
  const at = (ms: number) => ({ expiresAt: new Date(now + ms).toISOString() });

  it('drops offers within 2 minutes of expiring and keeps the rest', () => {
    const offers = [at(60_000), at(MIN_OFFER_LIFETIME_MS), at(MIN_OFFER_LIFETIME_MS + 1000), at(20 * 60_000), at(-5000)];
    const kept = stillBookable(offers, now);
    assert.equal(kept.length, 2);
    assert.deepEqual(kept.map((o) => o.expiresAt), [offers[2].expiresAt, offers[3].expiresAt]);
  });

  it('keys searches by route, date, party and cabin', () => {
    const a = offerCacheKey({ slices: [{ origin: 'kul', destination: 'IST', departureDate: '2026-11-21' }], passengers: 1 });
    const b = offerCacheKey({ slices: [{ origin: 'KUL', destination: 'IST', departureDate: '2026-11-21' }], passengers: 1 });
    const c = offerCacheKey({ slices: [{ origin: 'KUL', destination: 'IST', departureDate: '2026-11-21' }], passengers: 2 });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

describe('validateSearch', () => {
  const ok = { slices: [{ origin: 'KUL', destination: 'IST', departureDate: '2026-11-21' }], passengers: 1 };
  it('accepts a one-way, round-trip and multi-city search', () => {
    assert.equal(validateSearch(ok), null);
    assert.equal(validateSearch({ ...ok, slices: [...ok.slices, { origin: 'IST', destination: 'KUL', departureDate: '2026-11-26' }] }), null);
  });
  it('rejects bad codes, dates and party sizes', () => {
    assert.ok(validateSearch({ ...ok, slices: [{ origin: 'KULX', destination: 'IST', departureDate: '2026-11-21' }] }));
    assert.ok(validateSearch({ ...ok, slices: [{ origin: 'KUL', destination: 'KUL', departureDate: '2026-11-21' }] }));
    assert.ok(validateSearch({ ...ok, slices: [{ origin: 'KUL', destination: 'IST', departureDate: '21/11/2026' }] }));
    assert.ok(validateSearch({ ...ok, passengers: 0 }));
    assert.ok(validateSearch({ ...ok, slices: [] }));
    assert.ok(validateSearch(null));
  });
});

describe('normalizeOffer', () => {
  const airline = (name: string, iata: string) => ({ name, iata_code: iata, logo_symbol_url: `https://logo/${iata}.svg` });
  const airport = (iata: string, name: string) => ({ iata_code: iata, name, city_name: name });
  const seg = (n: string, from: [string, string], to: [string, string], dep: string, arr: string, dur: string) => ({
    marketing_carrier: airline('Etihad Airways', 'EY'),
    operating_carrier: airline('Etihad Airways', 'EY'),
    marketing_carrier_flight_number: n,
    origin: airport(...from),
    destination: airport(...to),
    departing_at: dep,
    arriving_at: arr,
    duration: dur,
    aircraft: { name: 'Boeing 787' },
    passengers: [{ cabin_class: 'economy' }],
  });
  const offer = {
    id: 'off_0000TEST',
    expires_at: '2026-11-21T10:30:00Z',
    total_amount: '565.40',
    total_currency: 'USD',
    owner: airline('Etihad Airways', 'EY'),
    passengers: [{ id: 'pas_1' }],
    slices: [
      {
        duration: 'PT20H10M',
        segments: [
          seg('411', ['KUL', 'Kuala Lumpur'], ['AUH', 'Abu Dhabi'], '2026-11-21T21:40:00', '2026-11-22T00:50:00', 'PT7H10M'),
          seg('97', ['AUH', 'Abu Dhabi'], ['IST', 'Istanbul'], '2026-11-22T08:45:00', '2026-11-22T12:50:00', 'PT5H05M'),
        ],
      },
    ],
  } as unknown as Parameters<typeof normalizeOffer>[0];

  it('maps carriers, segments, timestamps and the layover', () => {
    const raw = normalizeOffer(offer)!;
    assert.equal(raw.offerId, 'off_0000TEST');
    assert.equal(raw.baseAmount, 565.4);
    assert.equal(raw.currency, 'USD');
    assert.equal(raw.owner.iataCode, 'EY');
    assert.equal(raw.cabinClass, 'economy');
    const slice = raw.slices[0];
    assert.equal(slice.segments.length, 2);
    assert.equal(slice.segments[0].flightNumber, 'EY 411');
    assert.equal(slice.durationMinutes, 1210);
    assert.equal(slice.layovers.length, 1);
    assert.equal(slice.layovers[0].minutes, 7 * 60 + 55);
    assert.equal(slice.layovers[0].airport.iataCode, 'AUH');
    assert.equal(slice.origin.iataCode, 'KUL');
    assert.equal(slice.destination.iataCode, 'IST');
  });

  it('rejects an offer with no price or no flights', () => {
    assert.equal(normalizeOffer({ ...offer, total_amount: '0' } as never), null);
    assert.equal(normalizeOffer({ ...offer, slices: [] } as never), null);
  });
});

describe('Duffel webhook signature', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ type: 'order.created', data: { object: { id: 'ord_1', booking_reference: 'ABC123' } } });
  const sign = (t: number, payload = body, key = secret) =>
    `t=${t},v1=${createHmac('sha256', key).update(`${t}.${payload}`).digest('hex')}`;
  const now = 1_800_000_000_000;
  const t = now / 1000;

  it('accepts a correct, recent signature', () => {
    assert.equal(verifyDuffelSignature(body, sign(t), secret, 300, now), true);
    assert.equal(verifyDuffelSignature(Buffer.from(body), sign(t), secret, 300, now), true);
  });
  it('rejects a tampered body, wrong secret, missing header and stale timestamp', () => {
    assert.equal(verifyDuffelSignature(body + ' ', sign(t), secret, 300, now), false);
    assert.equal(verifyDuffelSignature(body, sign(t, body, 'other'), secret, 300, now), false);
    assert.equal(verifyDuffelSignature(body, undefined, secret, 300, now), false);
    assert.equal(verifyDuffelSignature(body, sign(t - 3600), secret, 300, now), false);
    assert.equal(verifyDuffelSignature(body, 't=abc,v1=zz', secret, 300, now), false);
  });
  it('finds our tracking reference inside a payload', () => {
    assert.equal(findReference({ metadata: { ref: 'astris_mhk3f9a1b2c3d4' } }), 'astris_mhk3f9a1b2c3d4');
    assert.equal(findReference({ other: 1 }), undefined);
  });
});
