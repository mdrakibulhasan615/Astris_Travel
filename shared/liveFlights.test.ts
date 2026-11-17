import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bookingOptionsCacheKey,
  liveSearchCacheKey,
  normalizeSerpFlights,
  offlineFallbackLinks,
  parseBookingOptions,
  parseStamp,
  postDataFields,
  sortSellerOptions,
  summarizeExtensions,
} from './liveFlights.ts';

const CTX = { currency: 'USD', fetchedAt: '2026-11-17T10:00:00.000Z' };

describe('summarizeExtensions: baggage from the fare strings', () => {
  it('carry-on included + checked bag for a fee is a carry-on-only fare', () => {
    const r = summarizeExtensions(['Carry-on bag included', 'Checked baggage for a fee']);
    assert.equal(r.baggageSummary, 'Carry-on only');
    assert.equal(r.baggage?.cabin, 'included');
    assert.equal(r.baggage?.checked, 'fee');
  });

  it('carry-on and a checked bag both included', () => {
    const r = summarizeExtensions(['Carry-on bag included', '1st checked bag included']);
    assert.equal(r.baggageSummary, '1 carry-on · Checked bag included');
    assert.equal(r.baggage?.checkedPieces, 1);
  });

  it('reads the carry-on weight and two included checked bags', () => {
    const r = summarizeExtensions(['Carry-on bag included (7 kg)', '2nd checked bag included', '1st checked bag included']);
    assert.match(r.baggageSummary, /^1 carry-on \(7 kg\) · /);
  });

  it('says so when the fare states nothing about bags, and keeps the amenities', () => {
    const r = summarizeExtensions(['Average legroom (31 in)', 'Wi-Fi for a fee', 'Carbon emissions estimate: 553 kg']);
    assert.equal(r.baggageSummary, 'Baggage not stated');
    assert.equal(r.baggage, null);
    assert.deepEqual(r.amenities, ['Average legroom (31 in)', 'Wi-Fi for a fee']);
  });

  it('no carry-on', () => {
    assert.equal(summarizeExtensions(['No carry-on baggage']).baggageSummary, 'No carry-on');
  });

  it('ignores empty and non-string entries', () => {
    assert.equal(summarizeExtensions(['', '  ', undefined as unknown as string]).baggageSummary, 'Baggage not stated');
  });
});

describe('parseStamp', () => {
  it('normalises provider timestamps', () => {
    assert.equal(parseStamp('2026-11-21 9:30'), '2026-11-21 09:30');
    assert.equal(parseStamp('2026-11-21T19:45:00'), '2026-11-21 19:45');
    assert.equal(parseStamp('nope'), null);
    assert.equal(parseStamp(undefined), null);
  });
});

const flight = (n: string, airline: string, from: [string, string, string], to: [string, string, string], dur: number, extra = {}) => ({
  flight_number: n,
  airline,
  airline_logo: `https://logos/${n.split(' ')[0]}.png`,
  airplane: 'Airbus A330',
  travel_class: 'Economy',
  legroom: '31 in',
  duration: dur,
  departure_airport: { id: from[0], name: from[1], time: from[2] },
  arrival_airport: { id: to[0], name: to[1], time: to[2] },
  ...extra,
});

const RESPONSE = {
  best_flights: [
    {
      flights: [
        flight('AK 880', 'AirAsia', ['KUL', 'Kuala Lumpur International Airport', '2026-11-21 06:30'], ['IST', 'Istanbul Airport', '2026-11-21 12:40'], 600, {
          extensions: ['Carry-on bag included'],
        }),
      ],
      total_duration: 600,
      price: 412,
      airline_logo: 'https://logos/AK.png',
      extensions: ['Checked baggage for a fee'],
      carbon_emissions: { this_flight: 553000 },
      booking_token: 'TOKEN-ONEWAY-AAAA',
    },
  ],
  other_flights: [
    {
      flights: [
        flight('MH 30', 'Malaysia Airlines', ['KUL', 'KLIA', '2026-11-21 23:55'], ['DOH', 'Hamad International', '2026-11-22 03:10'], 395),
        flight('TK 773', 'Turkish Airlines', ['DOH', 'Hamad International', '2026-11-22 07:00'], ['IST', 'Istanbul Airport', '2026-11-22 12:35'], 335),
      ],
      layovers: [{ id: 'DOH', name: 'Hamad International Airport', duration: 230, overnight: false }],
      total_duration: 960,
      price: 655,
      departure_token: 'DEPTOKEN-RT-BBBB',
    },
    // dropped: no price
    { flights: [flight('XX 1', 'Nope', ['KUL', 'K', '2026-11-21 01:00'], ['IST', 'I', '2026-11-21 09:00'], 480)], total_duration: 480 },
    // dropped: a flight with no usable time
    { flights: [flight('XX 2', 'Nope', ['KUL', 'K', 'garbage'], ['IST', 'I', '2026-11-21 09:00'], 480)], total_duration: 480, price: 100 },
  ],
};

describe('normalizeSerpFlights', () => {
  const offers = normalizeSerpFlights(RESPONSE, CTX);

  it('keeps best and other flights and drops incomplete itineraries instead of inventing values', () => {
    assert.equal(offers.length, 2);
  });

  it('maps a nonstop offer', () => {
    const o = offers[0];
    assert.equal(o.source, 'serpapi_live');
    assert.equal(o.airline.name, 'AirAsia');
    assert.equal(o.airline.iataCode, 'AK');
    assert.equal(o.airline.logo, 'https://logos/AK.png');
    assert.equal(o.flightNumber, 'AK 880');
    assert.equal(o.departureTime, '2026-11-21 06:30');
    assert.equal(o.arrivalTime, '2026-11-21 12:40');
    assert.equal(o.totalDurationMinutes, 600);
    assert.equal(o.stopsCount, 0);
    assert.equal(o.price, 412);
    assert.equal(o.currency, 'USD');
    assert.equal(o.bookingToken, 'TOKEN-ONEWAY-AAAA');
    assert.equal(o.departureToken, undefined);
    assert.equal(o.co2Kg, 553);
    assert.equal(o.baggageSummary, 'Carry-on only');
    assert.equal(o.fetchedAt, CTX.fetchedAt);
  });

  it('maps a connection with its layover and a departure token (round-trip outbound)', () => {
    const o = offers[1];
    assert.equal(o.flightNumber, 'MH 30 + TK 773');
    assert.equal(o.stopsCount, 1);
    assert.deepEqual(o.layovers, [{ airportName: 'Hamad International Airport', iata: 'DOH', durationMinutes: 230, overnight: false }]);
    assert.equal(o.departureToken, 'DEPTOKEN-RT-BBBB');
    assert.equal(o.bookingToken, undefined);
    assert.equal(o.segments.length, 2);
    assert.equal(o.segments[0].toIata, 'DOH');
    assert.equal(o.arrivalTime, '2026-11-22 12:35');
    assert.equal(o.baggageSummary, 'Baggage not stated');
  });

  it('gives the same id to the same itinerary and price, and different ids otherwise', () => {
    const again = normalizeSerpFlights(RESPONSE, CTX);
    assert.equal(again[0].id, offers[0].id);
    assert.notEqual(offers[0].id, offers[1].id);
    const pricier = normalizeSerpFlights({ best_flights: [{ ...RESPONSE.best_flights[0], price: 413 }] }, CTX);
    assert.notEqual(pricier[0].id, offers[0].id);
  });

  it('returns nothing for an empty or missing response', () => {
    assert.deepEqual(normalizeSerpFlights({}, CTX), []);
    assert.deepEqual(normalizeSerpFlights(null, CTX), []);
  });
});

const seller = (over: Record<string, unknown> = {}) => ({
  book_with: 'Malaysia Airlines',
  airline: true,
  price: 655,
  baggage_prices: ['1 free carry-on', '1st checked bag $32'],
  booking_request: { url: 'https://www.google.com/travel/clk/f', post_data: 'u=abc%3D%3D&f.req=%5B%5B1%5D%5D' },
  ...over,
});

describe('parseBookingOptions', () => {
  it('parses a ticket sold together, keeping post_data verbatim', () => {
    const [o] = parseBookingOptions({ booking_options: [{ together: seller() }] });
    assert.equal(o.bookWith, 'Malaysia Airlines');
    assert.equal(o.isAirlineDirect, true);
    assert.equal(o.price, 655);
    assert.equal(o.groupPrice, 655);
    assert.deepEqual(o.baggagePrices, ['1 free carry-on', '1st checked bag $32']);
    assert.equal(o.part, 'together');
    assert.equal(o.separateTickets, false);
    assert.equal(o.logo, undefined);
    assert.deepEqual(o.bookingRequest, { url: 'https://www.google.com/travel/clk/f', postData: 'u=abc%3D%3D&f.req=%5B%5B1%5D%5D' });
  });

  it("keeps the seller's logo when SerpApi sends one", () => {
    const [o] = parseBookingOptions({
      booking_options: [{ together: seller({ airline_logos: ['https://www.gstatic.com/flights/partner_logos/70px/CTRIP.png'] }) }],
    });
    assert.equal(o.logo, 'https://www.gstatic.com/flights/partner_logos/70px/CTRIP.png');
  });

  it('a seller without post_data has a plain url request (GET deep link)', () => {
    const [o] = parseBookingOptions({
      booking_options: [{ together: seller({ book_with: 'Trip.com', airline: false, booking_request: { url: 'https://trip.com/x' } }) }],
    });
    assert.equal(o.isAirlineDirect, false);
    assert.deepEqual(o.bookingRequest, { url: 'https://trip.com/x' });
    assert.ok(!('postData' in o.bookingRequest));
  });

  it('splits departing + returning tickets into linked rows with the group total', () => {
    const opts = parseBookingOptions({
      booking_options: [
        {
          separate_tickets: true,
          departing: seller({ book_with: 'AirAsia', price: 300 }),
          returning: seller({ book_with: 'Ryanair', price: 250, booking_request: { url: 'https://r.example/x' } }),
        },
      ],
    });
    assert.equal(opts.length, 2);
    assert.deepEqual(opts.map((o) => o.part), ['departing', 'returning']);
    assert.ok(opts.every((o) => o.separateTickets && o.groupPrice === 550 && o.groupId === opts[0].groupId));
    assert.equal(opts[1].bookingRequest.postData, undefined);
  });

  it('drops entries with no price or no booking url, and tolerates a missing list', () => {
    const opts = parseBookingOptions({
      booking_options: [
        { together: seller({ price: undefined }) },
        { together: seller({ booking_request: {} }) },
        { departing: seller(), returning: seller({ price: 0 }) },
        { together: seller({ book_with: 'Good' }) },
      ],
    });
    assert.deepEqual(opts.map((o) => o.bookWith), ['Good']);
    assert.deepEqual(parseBookingOptions({}), []);
    assert.deepEqual(parseBookingOptions(null), []);
  });

  it('sorts cheapest first, airline direct first on a tie, split rows kept together', () => {
    const opts = parseBookingOptions({
      booking_options: [
        { together: seller({ book_with: 'OTA', airline: false, price: 600 }) },
        { together: seller({ book_with: 'Airline', airline: true, price: 600 }) },
        { together: seller({ book_with: 'Cheap', airline: false, price: 580 }) },
        { departing: seller({ book_with: 'A', price: 300 }), returning: seller({ book_with: 'B', price: 250 }) },
      ],
    });
    const sorted = sortSellerOptions(opts);
    assert.deepEqual(sorted.map((o) => o.bookWith), ['A', 'B', 'Cheap', 'Airline', 'OTA']);
  });
});

describe('postDataFields (the POST handoff body)', () => {
  const original = 'u=abc%3D%3D&f.req=%5B%5B%22x%22%2C1%5D%5D&u=second&q=a+b%26c';

  it('decodes each field once and keeps order and repeated names', () => {
    assert.deepEqual(postDataFields(original), [
      ['u', 'abc=='],
      ['f.req', '[["x",1]]'],
      ['u', 'second'],
      ['q', 'a b&c'],
    ]);
  });

  it('re-encoding the fields (what the browser does on submit) gives back the same body', () => {
    assert.equal(new URLSearchParams(postDataFields(original)).toString(), original);
  });

  it('does not double-encode: an already-encoded %3D stays one level deep', () => {
    const [[, value]] = postDataFields('u=abc%3D%3D');
    assert.equal(value, 'abc==');
    assert.equal(new URLSearchParams([['u', value]]).toString(), 'u=abc%3D%3D');
  });

  it('handles an empty value and a value containing =', () => {
    assert.deepEqual(postDataFields('a=&b=x=y'), [
      ['a', ''],
      ['b', 'x=y'],
    ]);
  });
});

describe('cache keys and offline links', () => {
  const base = { originIata: 'kul', destinationIata: 'ist', departureDate: '2026-12-10' };

  it('searches differ by route, dates and currency, not by party size or letter case', () => {
    const k = liveSearchCacheKey({ ...base });
    assert.equal(liveSearchCacheKey({ ...base, originIata: 'KUL', adults: 3 }), k);
    assert.notEqual(liveSearchCacheKey({ ...base, returnDate: '2026-12-15' }), k);
    assert.notEqual(liveSearchCacheKey({ ...base, currency: 'MYR' }), k);
    assert.notEqual(liveSearchCacheKey({ ...base, departureDate: '2026-12-11' }), k);
  });

  it('booking-token keys differ per token and currency', () => {
    assert.equal(bookingOptionsCacheKey('abc'), bookingOptionsCacheKey('abc'));
    assert.notEqual(bookingOptionsCacheKey('abc'), bookingOptionsCacheKey('abd'));
    assert.notEqual(bookingOptionsCacheKey('abc'), bookingOptionsCacheKey('abc', 'MYR'));
  });

  it('builds exact-route Trip.com and Skyscanner links', () => {
    const links = offlineFallbackLinks({ originIata: 'KUL', destinationIata: 'IST', departureDate: '2026-12-10' });
    assert.deepEqual(links.map((l) => l.name), ['Trip.com', 'Skyscanner']);
    assert.match(links[0].url, /trip\.com\/flights\/showfarefirst\?.*dcity=kul.*acity=ist.*ddate=2026-12-10/);
    assert.match(links[1].url, /skyscanner\.net\/transport\/flights\/kul\/ist\/261210\/\?.*rtn=0/);
  });

  it('adds the return date for a round trip', () => {
    const links = offlineFallbackLinks({ originIata: 'KUL', destinationIata: 'IST', departureDate: '2026-12-10', returnDate: '2026-12-15' });
    assert.match(links[1].url, /\/kul\/ist\/261210\/261215\/\?.*rtn=1/);
  });
});
