import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import type { FlightProvider } from './flightProvider.ts';
import { registerLiveFlightRoutes } from './liveFlightsApi.ts';
import { createMemoryLimiter, RATE_LIMITS } from './security/rateLimit.ts';
import { buildCsp, securityMiddleware } from './security/headers.ts';
import { bookingOptionsSchema, parseLiveSearch, parseWith, safeNextPath } from './security/validation.ts';
import { safeHttpsUrl } from '../shared/safeUrl.ts';
import { parseBookingOptions } from '../shared/liveFlights.ts';

process.env.USE_REAL_DATA = 'true';

const ALLOWED = 'https://astris.example';
let calls = 0;
const provider: FlightProvider = {
  name: 'fake',
  async searchCorridor() {
    calls++;
    return [];
  },
  async getReturnFlights() {
    return [];
  },
  async getBookingOptions() {
    calls++;
    return [];
  },
};

function makeApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(securityMiddleware({ production: true, origins: new Set([ALLOWED]) }));
  app.use(express.json());
  registerLiveFlightRoutes(app, provider, {
    liveSearch: createMemoryLimiter({ max: RATE_LIMITS.liveSearch.max, windowMs: RATE_LIMITS.liveSearch.windowSeconds * 1000 }),
    returnFlights: createMemoryLimiter({ max: RATE_LIMITS.returnFlights.max, windowMs: 600_000 }),
    bookingOptions: createMemoryLimiter({ max: RATE_LIMITS.bookingOptions.max, windowMs: RATE_LIMITS.bookingOptions.windowSeconds * 1000 }),
  });
  app.get('/api/ping', (_req, res) => res.json({ ok: true }));
  app.post('/api/echo', (_req, res) => res.json({ ok: true }));
  return app;
}

let server: ReturnType<ReturnType<typeof makeApp>['listen']>;
let base = '';
before(async () => {
  server = makeApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const search = { originIata: 'KUL', destinationIata: 'IST', departureDate: '2026-12-10' };
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, ...headers },
    body: JSON.stringify(body),
  });

describe('rate limiting', () => {
  it('answers 429 with Retry-After on the 6th live search from one IP within 10 minutes', async () => {
    const ip = { 'X-Forwarded-For': '203.0.113.7' };
    for (let i = 0; i < 5; i++) {
      const res = await post('/api/flights/live-search', search, ip);
      assert.equal(res.status, 200, `request ${i + 1}`);
    }
    const blocked = await post('/api/flights/live-search', search, ip);
    assert.equal(blocked.status, 429);
    const retryAfter = Number(blocked.headers.get('retry-after'));
    assert.ok(retryAfter >= 1 && retryAfter <= 600, `Retry-After ${retryAfter}`);
    assert.equal((await blocked.json()).error, 'RATE_LIMITED');
    // Another IP is unaffected
    assert.equal((await post('/api/flights/live-search', search, { 'X-Forwarded-For': '203.0.113.8' })).status, 200);
  });

  it('blocks a blocked request before it reaches the provider (no quota spent)', async () => {
    const ip = { 'X-Forwarded-For': '198.51.100.1' };
    for (let i = 0; i < 5; i++) await post('/api/flights/live-search', { ...search, departureDate: `2026-12-1${i}` }, ip);
    const before = calls;
    assert.equal((await post('/api/flights/live-search', { ...search, departureDate: '2026-12-19' }, ip)).status, 429);
    assert.equal(calls, before);
  });

  it('allows 15 booking-option lookups per IP, then 429', async () => {
    const ip = { 'X-Forwarded-For': '192.0.2.44' };
    const body = { bookingToken: 'WyJDalJJ_token-123', search };
    for (let i = 0; i < 15; i++) assert.equal((await post('/api/flights/booking-options', body, ip)).status, 200);
    const res = await post('/api/flights/booking-options', body, ip);
    assert.equal(res.status, 429);
    assert.ok(res.headers.get('retry-after'));
  });

  it('memory sliding window frees a slot once the oldest hit leaves the window', async () => {
    let t = 0;
    const lim = createMemoryLimiter({ max: 2, windowMs: 1000, now: () => t });
    assert.equal((await lim.limit('k')).success, true);
    t = 400;
    assert.equal((await lim.limit('k')).success, true);
    t = 900;
    const blocked = await lim.limit('k');
    assert.equal(blocked.success, false);
    assert.equal(blocked.reset, 1000);
    t = 1001;
    assert.equal((await lim.limit('k')).success, true);
  });
});

describe('zod validation', () => {
  it('rejects malformed live-search bodies with 400', async () => {
    // Junk counts toward the rate limit too, so each body comes from its own address
    let n = 0;
    for (const bad of [
      { ...search, originIata: 'K1L' },
      { ...search, originIata: "KUL' OR 1=1--" },
      { ...search, departureDate: '2026-02-31' },
      { ...search, adults: 99 },
      { ...search, adults: '2; DROP TABLE' },
      { ...search, currency: '<script>' },
      { ...search, returnDate: '2026-12-01' },
      {},
    ]) {
      const res = await post('/api/flights/live-search', bad, { 'X-Forwarded-For': `10.9.9.${++n}` });
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal((await res.json()).error, 'BAD_REQUEST');
    }
  });

  it('normalises case but enforces exactly three letters', () => {
    assert.equal(parseLiveSearch({ ...search, originIata: ' kul ' }).ok, true);
    assert.equal(parseLiveSearch({ ...search, originIata: 'KULA' }).ok, false);
    assert.equal(parseLiveSearch({ ...search, originIata: 'x'.repeat(5000) }).ok, false);
  });

  it('rejects booking tokens that carry markup or are oversized', () => {
    assert.equal(parseWith(bookingOptionsSchema, { bookingToken: '<script>alert(1)</script>', search }).ok, false);
    assert.equal(parseWith(bookingOptionsSchema, { bookingToken: 'a'.repeat(9000), search }).ok, false);
    assert.equal(parseWith(bookingOptionsSchema, { bookingToken: 'WyJDalJJ_token-123', search }).ok, true);
  });

  it('only allows same-site relative post-login redirects', () => {
    assert.equal(safeNextPath('/trips?x=1'), '/trips?x=1');
    for (const bad of ['https://evil.com', '//evil.com', '/\\evil.com', 'javascript:alert(1)', 42]) assert.equal(safeNextPath(bad), '/');
  });
});

describe('XSS URL sanitisation', () => {
  it('blocks javascript:, data: and other non-https URLs', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(document.cookie)',
      '  javascript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'http://airline.example/checkout',
      '//evil.example/x',
      '/relative/path',
      'https://user:pass@airline.example/',
      '',
      null,
    ]) {
      assert.equal(safeHttpsUrl(bad), null, String(bad));
    }
    assert.equal(safeHttpsUrl('https://www.airline.example/book?x=1'), 'https://www.airline.example/book?x=1');
  });

  it('drops sellers whose booking_request.url is not https when parsing SerpApi', () => {
    const options = parseBookingOptions({
      booking_options: [
        { together: { book_with: 'Evil', price: 100, booking_request: { url: 'javascript:alert(1)' } } },
        { together: { book_with: 'Data', price: 100, booking_request: { url: 'data:text/html,hi' } } },
        { together: { book_with: 'Good Air', price: 120, booking_request: { url: 'https://good.example/pay' } } },
      ],
    } as Parameters<typeof parseBookingOptions>[0]);
    assert.deepEqual(options.map((o) => o.bookWith), ['Good Air']);
  });
});

describe('headers, CORS and CSRF', () => {
  it('sends strict security headers', async () => {
    const res = await fetch(`${base}/api/ping`);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.match(res.headers.get('strict-transport-security') ?? '', /max-age=\d+/);
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.ok(res.headers.get('permissions-policy'));
    const cookie = res.headers.get('set-cookie') ?? '';
    assert.match(cookie, /astris_sid=.*HttpOnly.*SameSite=Lax.*Secure/);
  });

  it('never answers Access-Control-Allow-Origin: * and only echoes the allowlist', async () => {
    const evil = await fetch(`${base}/api/ping`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const good = await fetch(`${base}/api/ping`, { headers: { Origin: ALLOWED } });
    assert.equal(good.headers.get('access-control-allow-origin'), ALLOWED);
    const preflight = await fetch(`${base}/api/echo`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    assert.equal(preflight.status, 403);
  });

  it('blocks cross-site and origin-less state-changing requests', async () => {
    assert.equal((await post('/api/echo', {}, { Origin: 'https://evil.example' })).status, 403);
    const none = await fetch(`${base}/api/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(none.status, 403);
    assert.equal((await post('/api/echo', {})).status, 200);
    assert.equal((await post('/api/echo', {}, { Origin: ALLOWED })).status, 200);
  });

  it('vercel.json carries the same CSP as the Express app', () => {
    const vercel = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'vercel.json'), 'utf8'));
    const csp = vercel.headers?.[0]?.headers?.find((h: { key: string }) => h.key === 'Content-Security-Policy')?.value;
    assert.equal(csp, buildCsp(), 'run `npm run headers:sync`');
  });
});

describe('secret audit', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const SECRETS = ['SERPAPI_API_KEY', 'SERPAPI_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'UPSTASH_REDIS_REST_TOKEN', 'TRAVELPAYOUTS_TOKEN', 'GOOGLE_MAPS_API_KEY'];
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      return d.isDirectory() ? walk(p) : /\.(tsx?|jsx?)$/.test(d.name) && !d.name.includes('.test.') ? [p] : [];
    });

  it('browser code never names a server secret, and no secret is a VITE_ variable', () => {
    for (const file of [...walk(path.join(root, 'src')), ...walk(path.join(root, 'shared'))]) {
      const text = fs.readFileSync(file, 'utf8');
      const rel = path.relative(root, file);
      // Browser code may only read import.meta.env.DEV / MODE / VITE_* public ids, never process.env
      assert.ok(!/process.env/.test(text) || rel.startsWith('shared'), `${rel} reads process.env`);
      for (const s of SECRETS) assert.ok(!new RegExp(`(env\.|\[['"])${s}`).test(text), `${rel} reads ${s}`);
      assert.ok(!/VITE_[A-Z_]*(SECRET|TOKEN|SERVICE_ROLE|API_KEY|PASSWORD|SERPAPI|UPSTASH)/.test(text), `${rel} reads a secret VITE_ variable`);
    }
    const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    assert.ok(!/^\s*#?\s*VITE_[A-Z_]*(SECRET|TOKEN|SERVICE_ROLE|SERPAPI|UPSTASH|API_KEY)/m.test(example));
    const viteConfig = fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8');
    assert.ok(!/process\.env\.(?!DISABLE_HMR)/.test(viteConfig), 'vite.config.ts must not define process.env values into the bundle');
  });
});

describe('placeholder env values', () => {
  it('treats example URLs from the docs as missing', async () => {
    const { getEnv } = await import('./env.ts');
    process.env.__T_APP_URL = 'https://your-app.vercel.app';
    process.env.__T_SB = '"https://your-project-ref.supabase.co"';
    process.env.__T_REAL = 'https://astris-travel.vercel.app';
    assert.equal(getEnv('__T_APP_URL'), undefined);
    assert.equal(getEnv('__T_SB'), undefined);
    assert.equal(getEnv('__T_REAL'), 'https://astris-travel.vercel.app');
  });
});
