import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSerpApiProvider, ProviderError } from './flightProvider.ts';
import { parseLiveSearch } from './liveFlightsApi.ts';
import { createTtlCache, getOrFetch, type RedisLike } from './ttlCache.ts';

// ── The 30-minute corridor cache ─────────────────────────────────────────────────────────────────

function fakeRedis() {
  const store = new Map<string, { value: unknown; ex: number }>();
  const redis: RedisLike & { store: typeof store; fail: boolean } = {
    store,
    fail: false,
    async get<T>(key: string) {
      if (redis.fail) throw new Error('redis down');
      return (store.get(key)?.value as T) ?? null;
    },
    async set(key, value, opts) {
      if (redis.fail) throw new Error('redis down');
      store.set(key, { value, ex: opts.ex });
    },
  };
  return redis;
}

describe('createTtlCache / getOrFetch (30-minute TTL)', () => {
  const TTL = 30 * 60;

  it('a miss runs the fetcher once and a hit within 30 minutes does not', async () => {
    let t = 0;
    const cache = createTtlCache<string[]>({ ttlSeconds: TTL, now: () => t });
    let calls = 0;
    const fetcher = async () => (calls++, ['fare']);

    const first = await getOrFetch(cache, 'k', fetcher);
    assert.deepEqual(first, { value: ['fare'], cached: false });
    t = 29 * 60 * 1000;
    const second = await getOrFetch(cache, 'k', fetcher);
    assert.deepEqual(second, { value: ['fare'], cached: true });
    assert.equal(calls, 1);
  });

  it('expires after 30 minutes and fetches again', async () => {
    let t = 0;
    const cache = createTtlCache<number>({ ttlSeconds: TTL, now: () => t });
    let calls = 0;
    await getOrFetch(cache, 'k', async () => ++calls);
    t = TTL * 1000 + 1;
    const again = await getOrFetch(cache, 'k', async () => ++calls);
    assert.equal(again.cached, false);
    assert.equal(again.value, 2);
  });

  it('keys are independent', async () => {
    const cache = createTtlCache<string>({ ttlSeconds: TTL });
    await getOrFetch(cache, 'KUL:IST', async () => 'a');
    const other = await getOrFetch(cache, 'KUL:LHR', async () => 'b');
    assert.equal(other.cached, false);
    assert.equal(other.value, 'b');
  });

  it('writes to Redis with the TTL, and a fresh instance (a cold start) hits Redis, not the provider', async () => {
    const redis = fakeRedis();
    const warm = createTtlCache<string>({ ttlSeconds: TTL, redis: () => redis });
    await getOrFetch(warm, 'k', async () => 'live');
    assert.equal(redis.store.get('k')?.ex, TTL);

    const cold = createTtlCache<string>({ ttlSeconds: TTL, redis: () => redis });
    let calls = 0;
    const hit = await getOrFetch(cold, 'k', async () => (calls++, 'again'));
    assert.deepEqual(hit, { value: 'live', cached: true });
    assert.equal(calls, 0);
    assert.equal((await cold.get('k'))?.layer, 'memory'); // now warmed
  });

  it('works memory-only when Redis is not configured', async () => {
    const cache = createTtlCache<string>({ ttlSeconds: TTL, redis: () => null });
    await getOrFetch(cache, 'k', async () => 'v');
    assert.equal((await getOrFetch(cache, 'k', async () => 'x')).cached, true);
  });

  it('a Redis outage never fails a request', async () => {
    const redis = fakeRedis();
    redis.fail = true;
    const cache = createTtlCache<string>({ ttlSeconds: TTL, redis: () => redis });
    const r = await getOrFetch(cache, 'k', async () => 'v');
    assert.deepEqual(r, { value: 'v', cached: false });
    assert.equal((await getOrFetch(cache, 'k', async () => 'x')).cached, true); // memory still serves it
  });

  it('does not cache a failed fetch', async () => {
    const cache = createTtlCache<string>({ ttlSeconds: TTL });
    await assert.rejects(getOrFetch(cache, 'k', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await cache.get('k'), null);
  });

  it('evicts the oldest entry past maxEntries', async () => {
    const cache = createTtlCache<number>({ ttlSeconds: TTL, maxEntries: 2 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.set('c', 3);
    assert.equal(await cache.get('a'), null);
    assert.equal((await cache.get('c'))?.value, 3);
  });
});

// ── The SerpApi provider (with a fake fetch: no network, no quota) ───────────────────────────────

function fakeFetch(responses: { status?: number; body: unknown }[]) {
  const urls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(new URL(String(input)));
    const r = responses[Math.min(urls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

const provider = (f: ReturnType<typeof fakeFetch>, key: string | null = 'test-key') =>
  createSerpApiProvider({ apiKey: () => key ?? undefined, fetchImpl: f.fetchImpl, baseUrl: () => 'https://serp.test/search.json', now: () => new Date('2026-11-17T10:00:00Z') });

const ONE_FLIGHT = {
  best_flights: [
    {
      flights: [
        {
          flight_number: 'AK 880',
          airline: 'AirAsia',
          duration: 600,
          departure_airport: { id: 'KUL', name: 'KLIA', time: '2026-12-10 06:30' },
          arrival_airport: { id: 'IST', name: 'Istanbul Airport', time: '2026-12-10 12:40' },
        },
      ],
      total_duration: 600,
      price: 412,
      booking_token: 'BTOKEN-12345678',
    },
  ],
};

describe('SerpApi provider', () => {
  it('step 1: a one-way search uses type=2 and every airport of the city', async () => {
    const f = fakeFetch([{ body: ONE_FLIGHT }]);
    const offers = await provider(f).searchCorridor({ originIata: 'KUL', destinationIata: 'IST', departureDate: '2026-12-10' });
    const q = f.urls[0].searchParams;
    assert.equal(q.get('engine'), 'google_flights');
    assert.equal(q.get('type'), '2');
    assert.equal(q.get('outbound_date'), '2026-12-10');
    assert.equal(q.get('return_date'), null);
    assert.equal(q.get('api_key'), 'test-key');
    assert.match(q.get('departure_id')!, /^KUL/);
    assert.equal(offers.length, 1);
    assert.equal(offers[0].bookingToken, 'BTOKEN-12345678');
  });

  it('step 1: a round trip uses type=1 with a return date and one airport per side', async () => {
    const f = fakeFetch([{ body: ONE_FLIGHT }]);
    await provider(f).searchCorridor({ originIata: 'LON', destinationIata: 'PAR', departureDate: '2026-12-10', returnDate: '2026-12-15' });
    const q = f.urls[0].searchParams;
    assert.equal(q.get('type'), '1');
    assert.equal(q.get('return_date'), '2026-12-15');
    assert.ok(!q.get('departure_id')!.includes(','));
    assert.ok(!q.get('arrival_id')!.includes(','));
  });

  it('a round-trip return leg sends the departure_token with the same search', async () => {
    const f = fakeFetch([{ body: ONE_FLIGHT }]);
    await provider(f).getReturnFlights({
      originIata: 'KUL', destinationIata: 'IST', departureDate: '2026-12-10', returnDate: '2026-12-15', departureToken: 'DEPTOK-1234',
    });
    const q = f.urls[0].searchParams;
    assert.equal(q.get('departure_token'), 'DEPTOK-1234');
    assert.equal(q.get('type'), '1');
  });

  it('step 2: the booking_token call repeats the search it came from (the live API rejects a bare token)', async () => {
    const f = fakeFetch([{ body: { booking_options: [{ together: { book_with: 'AirAsia', airline: true, price: 412, booking_request: { url: 'https://x.test/b', post_data: 'u=1' } } }] } }]);
    const search = { originIata: 'KUL', destinationIata: 'IST', departureDate: '2026-12-10' };
    const options = await provider(f).getBookingOptions({ bookingToken: 'BTOKEN-12345678', search });
    const q = f.urls[0].searchParams;
    assert.equal(q.get('booking_token'), 'BTOKEN-12345678');
    assert.equal(q.get('engine'), 'google_flights');
    assert.equal(q.get('outbound_date'), '2026-12-10');
    assert.equal(q.get('type'), '2');
    assert.match(q.get('departure_id')!, /^KUL/);
    // exactly the airports the original search asked for, so Google recognises the token
    const sameAsSearch = fakeFetch([{ body: ONE_FLIGHT }]);
    await provider(sameAsSearch).searchCorridor(search);
    assert.equal(q.get('departure_id'), sameAsSearch.urls[0].searchParams.get('departure_id'));
    assert.equal(q.get('arrival_id'), sameAsSearch.urls[0].searchParams.get('arrival_id'));
    assert.equal(options[0].bookingRequest.postData, 'u=1');
  });

  it('a round-trip token is looked up with the round-trip search', async () => {
    const f = fakeFetch([{ body: { booking_options: [{ together: { book_with: 'X', price: 1, booking_request: { url: 'https://x.test' } } }] } }]);
    await provider(f).getBookingOptions({
      bookingToken: 'BTOKEN-12345678',
      search: { originIata: 'KUL', destinationIata: 'IST', departureDate: '2026-12-10', returnDate: '2026-12-15' },
    });
    const q = f.urls[0].searchParams;
    assert.equal(q.get('type'), '1');
    assert.equal(q.get('return_date'), '2026-12-15');
  });

  it('a missing-parameter error is our bug (BAD_REQUEST), not an expired fare', async () => {
    await assert.rejects(
      provider(fakeFetch([{ status: 400, body: { error: 'Missing `departure_id` parameter.' } }])).getBookingOptions({
        bookingToken: 'BTOKEN-12345678',
        search: { originIata: 'KUL', destinationIata: 'IST', departureDate: '2026-12-10' },
      }),
      (e: ProviderError) => e.code === 'BAD_REQUEST'
    );
  });

  it('no key → NO_KEY, without calling out', async () => {
    const f = fakeFetch([{ body: {} }]);
    await assert.rejects(
      provider(f, null).searchCorridor({ originIata: 'KUL', destinationIata: 'IST', departureDate: '2026-12-10' }),
      (e: ProviderError) => e.code === 'NO_KEY'
    );
    assert.equal(f.urls.length, 0);
  });

  it('HTTP 429 and "out of searches" → QUOTA_EXCEEDED', async () => {
    const req = { originIata: 'KUL', destinationIata: 'IST', departureDate: '2026-12-10' };
    await assert.rejects(provider(fakeFetch([{ status: 429, body: { error: 'Too many requests' } }])).searchCorridor(req), (e: ProviderError) => e.code === 'QUOTA_EXCEEDED');
    await assert.rejects(
      provider(fakeFetch([{ status: 200, body: { error: 'Your account has run out of searches.' } }])).searchCorridor(req),
      (e: ProviderError) => e.code === 'QUOTA_EXCEEDED'
    );
  });

  it('an invalid or expired booking_token → TOKEN_EXPIRED', async () => {
    await assert.rejects(
      provider(fakeFetch([{ status: 400, body: { error: 'Invalid booking token.' } }])).getBookingOptions({ bookingToken: 'OLD-TOKEN-1234', search: { originIata: 'KUL', destinationIata: 'IST', departureDate: '2026-12-10' } }),
      (e: ProviderError) => e.code === 'TOKEN_EXPIRED'
    );
    await assert.rejects(
      provider(fakeFetch([{ body: { booking_options: [] } }])).getBookingOptions({ bookingToken: 'OLD-TOKEN-1234', search: { originIata: 'KUL', destinationIata: 'IST', departureDate: '2026-12-10' } }),
      (e: ProviderError) => e.code === 'TOKEN_EXPIRED'
    );
  });

  it('"no results" is an empty list, not an error', async () => {
    const f = fakeFetch([{ body: { error: "Google Flights hasn't returned any results for this query." } }]);
    assert.deepEqual(await provider(f).searchCorridor({ originIata: 'KUL', destinationIata: 'IST', departureDate: '2026-12-10' }), []);
  });

  it('anything else is UPSTREAM_ERROR', async () => {
    await assert.rejects(
      provider(fakeFetch([{ status: 500, body: { error: 'boom' } }])).searchCorridor({ originIata: 'KUL', destinationIata: 'IST', departureDate: '2026-12-10' }),
      (e: ProviderError) => e.code === 'UPSTREAM_ERROR'
    );
  });
});

describe('parseLiveSearch', () => {
  it('normalises a valid body and defaults adults and currency', () => {
    const r = parseLiveSearch({ originIata: 'kul', destinationIata: 'ist', departureDate: '2026-12-10' });
    assert.deepEqual(r, { ok: true, value: { originIata: 'KUL', destinationIata: 'IST', departureDate: '2026-12-10', returnDate: undefined, adults: 1, currency: 'USD' } });
  });

  it('rejects bad codes, dates, a return before the departure, and bad party sizes', () => {
    const base = { originIata: 'KUL', destinationIata: 'IST', departureDate: '2026-12-10' };
    for (const bad of [
      { ...base, originIata: 'KUALA' },
      { ...base, destinationIata: 'KUL' },
      { ...base, departureDate: '10/12/2026' },
      { ...base, returnDate: '2026-12-01' },
      { ...base, adults: 0 },
      { ...base, adults: 10 },
      { ...base, currency: 'US' },
    ]) {
      assert.equal(parseLiveSearch(bad).ok, false, JSON.stringify(bad));
    }
    assert.equal(parseLiveSearch(null).ok, false);
  });
});
