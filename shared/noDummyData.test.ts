import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildFlightOffers, buildBookingLink } from './affiliate.ts';
import { createDefaultTrip, DESTINATION_HUBS, INITIAL_STOPS } from './destinations.ts';
import { buildLegsFromStops } from './smartScore.ts';
import { buildStaySearches } from './stays.ts';
import { completeTicketDetails } from './ticketDetails.ts';
import type { TransitOption, TripStop } from './types.ts';

const stop = (id: string, city: string, iata: string, lat: number, lng: number, arrival: string, departure: string): TripStop => ({
  id, order: 1, city, country: 'X', iataCode: iata, lat, lng, stayNights: 3, arrivalDate: arrival, departureDate: departure,
});
const KUL = stop('s1', 'Kuala Lumpur', 'KUL', 3.139, 101.687, '2026-11-21', '2026-11-21');
const IST = stop('s2', 'Istanbul', 'IST', 41.008, 28.978, '2026-11-22', '2026-11-26');

describe('no made-up fares, schedules or prices', () => {
  it('a new trip starts at the origin only, with no legs', () => {
    const trip = createDefaultTrip();
    assert.equal(INITIAL_STOPS.length, 1);
    assert.deepEqual(trip.stops.map((s) => s.iataCode), ['KUL']);
    assert.deepEqual(trip.legs, []);
  });

  it('a leg between two stops has the route and distance but no options', () => {
    const [leg] = buildLegsFromStops([KUL, IST], 15);
    assert.equal(leg.fromCode, 'KUL');
    assert.equal(leg.toCode, 'IST');
    assert.ok(leg.distanceKm > 7000);
    assert.deepEqual(leg.transitOptions, []);
    assert.deepEqual(leg.oneWayOptions, []);
    assert.equal(leg.returnOptions, undefined);
    assert.equal(leg.selectedOptionId, '');
  });

  it('keeps real fares across an edit when the search is unchanged, and drops them when it changes', () => {
    const real: TransitOption = {
      id: 'real-1', mode: 'flight', isOvernightSleeper: false, carrier: 'Qatar Airways', carrierCode: 'QR', routeCode: 'QR 853',
      originStation: 'KUL', destinationStation: 'IST', departureTime: '19:55', arrivalTime: '02:35', inVehicleHours: 11, layoverHours: 0.5,
      stopsCount: 1, basePriceUsd: 306, smartScore: 0, smartScoreBreakdown: {} as never, doorToDoorNotes: '', co2Kg: 0, dataSource: 'cached',
    };
    const [first] = buildLegsFromStops([KUL, IST], 15);
    const withFare = { ...first, oneWayOptions: [real], transitOptions: [real] };
    const [kept] = buildLegsFromStops([KUL, IST], 15, undefined, { previousLegs: [withFare] });
    assert.deepEqual(kept.oneWayOptions?.map((o) => o.id), ['real-1']);
    const moved = { ...IST, departureDate: '2026-11-27' };
    // a different traveller count is a different search
    const [dropped] = buildLegsFromStops([KUL, moved], 15, undefined, { previousLegs: [withFare], passengers: 3 });
    assert.deepEqual(dropped.oneWayOptions, []);
  });

  it('a stay search has the city, dates, party and partner links, and no prices', () => {
    const [search] = buildStaySearches([KUL, IST], 2);
    assert.equal(search.city, 'Istanbul');
    assert.equal(search.nights, 4);
    assert.equal(search.adults, 2);
    assert.ok(search.links.length > 0);
    assert.ok(!('options' in search));
    assert.doesNotMatch(JSON.stringify(search), /nightly|totalPrice|commute/i);
  });

  it('merchant rows carry a price only for the merchant that really quoted it', () => {
    const option = {
      id: 'o1', mode: 'flight' as const, basePriceUsd: 306, departureAt: '2026-11-21 19:55', ticketType: 'one-way' as const,
      sourceFareUrl: 'https://www.aviasales.com/search/x', dataSource: 'cached' as const,
    };
    const ctx = { fromCode: 'KUL', toCode: 'IST', fromCity: 'Kuala Lumpur', toCity: 'Istanbul', date: '2026-11-21', passengers: 1 };
    const rows = buildFlightOffers(option, ctx, buildBookingLink(option, ctx));
    assert.equal(rows[0].providerId, 'aviasales');
    assert.equal(rows[0].priceUsd, 306);
    assert.deepEqual(rows.slice(1).map((r) => r.priceUsd), rows.slice(1).map(() => undefined));
    assert.ok(rows.length >= 4);
    assert.ok(rows.every((r) => !('estimated' in r)));
  });

  it('baggage is never guessed from the airline', () => {
    const option = {
      id: 'o1', mode: 'flight' as const, isOvernightSleeper: false, carrier: 'Qatar Airways', carrierCode: 'QR', routeCode: 'QR 853',
      originStation: 'KUL', destinationStation: 'IST', departureTime: '19:55', arrivalTime: '02:35', inVehicleHours: 11, layoverHours: 0,
      stopsCount: 0, basePriceUsd: 306, smartScore: 0, smartScoreBreakdown: {} as never, doorToDoorNotes: '', co2Kg: 0,
    } as TransitOption;
    assert.equal(completeTicketDetails(option, '2026-11-21').baggage, undefined);
  });

  it('the city suggestions list is reference data only', () => {
    assert.ok(DESTINATION_HUBS.length > 5);
    assert.ok(DESTINATION_HUBS.every((h) => !('basePriceUsd' in h)));
  });
});
