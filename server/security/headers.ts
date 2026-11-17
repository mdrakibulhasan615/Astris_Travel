import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getEnv, IS_PRODUCTION } from '../env.ts';
import { SESSION_COOKIE, sessionIdOf } from './rateLimit.ts';

/**
 * HTTP hardening for the Express app (API on Vercel, API + static files when self-hosted):
 * security headers (CSP, HSTS, frame/sniff/referrer/permissions policies), a strict CORS allowlist,
 * an Origin check on every state-changing request (CSRF), and the anonymous `astris_sid` cookie the
 * rate limiter keys on. On Vercel the static `dist/` files are served by the CDN, so `vercel.json`
 * carries the same headers; `server/security.test.ts` checks the two CSPs stay identical.
 */

/** Hosts the browser talks to: map tiles/styles/glyphs, fonts, analytics, the affiliate script. */
export const CSP_SOURCES = {
  script: ["'self'", 'https://tp-em.com', 'https://va.vercel-scripts.com'],
  style: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  font: ["'self'", 'data:', 'https://fonts.gstatic.com'],
  connect: [
    "'self'",
    'https://*.supabase.co',
    'https://tiles.openfreemap.org',
    'https://tile.openstreetmap.org',
    'https://*.tile.openstreetmap.org',
    'https://tp-em.com',
    'https://va.vercel-scripts.com',
  ],
};

/** The Content-Security-Policy value. `extraConnect` adds e.g. a custom Supabase domain. */
export function buildCsp(extraConnect: string[] = []): string {
  const connect = [...new Set([...CSP_SOURCES.connect, ...extraConnect])];
  return [
    "default-src 'self'",
    `script-src ${CSP_SOURCES.script.join(' ')}`,
    `style-src ${CSP_SOURCES.style.join(' ')}`,
    `font-src ${CSP_SOURCES.font.join(' ')}`,
    // Airline logos, hotel photos and map tiles come from many CDNs, always over https
    "img-src 'self' data: blob: https:",
    `connect-src ${connect.join(' ')}`,
    // MapLibre runs its tile parser in a blob: worker
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    // Seller checkouts are real POST forms to the airline / agency (https only)
    "form-action 'self' https:",
    'upgrade-insecure-requests',
  ].join('; ');
}

export const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()';

/** Headers sent on every response (CSP only in production: Vite's dev server injects inline scripts). */
export function securityHeaderValues(opts: { production: boolean; extraConnect?: string[] }): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': PERMISSIONS_POLICY,
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    'X-DNS-Prefetch-Control': 'off',
  };
  if (opts.production) {
    headers['Content-Security-Policy'] = buildCsp(opts.extraConnect);
    headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains; preload';
  }
  return headers;
}

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Origins allowed to call the API cross-origin: `ALLOWED_ORIGINS` (comma-separated), `APP_URL`,
 * Vercel's production / deployment URLs, and localhost outside production. Never `*`.
 */
export function allowedOrigins(env: (name: string) => string | undefined = getEnv, production = IS_PRODUCTION): Set<string> {
  const out = new Set<string>();
  const add = (v: string | undefined) => {
    const o = originOf(v);
    if (o) out.add(o);
  };
  for (const v of (env('ALLOWED_ORIGINS') ?? '').split(',')) add(v.trim());
  add(env('APP_URL'));
  const prod = env('VERCEL_PROJECT_PRODUCTION_URL');
  if (prod) add(`https://${prod}`);
  const deployment = env('VERCEL_URL');
  if (deployment) add(`https://${deployment}`);
  if (!production) {
    for (const host of ['localhost', '127.0.0.1']) {
      for (const port of ['3000', '5173', '4173']) out.add(`http://${host}:${port}`);
    }
  }
  return out;
}

/** The origin this request was addressed to (behind Vercel's proxy: X-Forwarded-Host/Proto). */
export function requestOrigin(req: Request): string | null {
  const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim() || req.headers.host;
  if (!host) return null;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || req.protocol || 'http';
  return originOf(`${proto}://${host}`);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface SecurityOptions {
  production?: boolean;
  origins?: Set<string>;
  extraConnect?: string[];
}

/** Headers + CORS + CSRF + session cookie, mounted before every route. */
export function securityMiddleware(opts: SecurityOptions = {}): RequestHandler {
  const production = opts.production ?? IS_PRODUCTION;
  const supabase = originOf(getEnv('SUPABASE_URL'));
  const headers = securityHeaderValues({
    production,
    extraConnect: [...(opts.extraConnect ?? []), ...(supabase ? [supabase] : [])],
  });
  let origins = opts.origins;

  return (req: Request, res: Response, next: NextFunction) => {
    origins ??= allowedOrigins(getEnv, production);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

    const isApi = req.path.startsWith('/api/') || req.path === '/api';
    if (!isApi) return next();
    res.setHeader('Cache-Control', res.getHeader('Cache-Control') ?? 'no-store');

    const origin = originOf(req.headers.origin as string | undefined);
    const self = requestOrigin(req);
    const sameOrigin = origin !== null && origin === self;
    const allowed = origin !== null && (sameOrigin || origins.has(origin));

    // CORS: echo only an allowlisted origin; everything else gets no Access-Control-Allow-Origin
    if (origin && allowed && !sameOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.append('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      if (!allowed) return res.status(403).json({ error: 'FORBIDDEN', message: 'Origin not allowed.' });
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }

    // CSRF: a state-changing request must come from our own pages. Browsers always send Origin on a
    // cross-site POST; a request with neither Origin nor Referer is refused in production.
    if (!SAFE_METHODS.has(req.method)) {
      const claimed = origin ?? originOf(req.headers.referer as string | undefined);
      const ok = claimed ? claimed === self || origins.has(claimed) : !production;
      if (!ok) {
        console.warn(`[Security] blocked ${req.method} ${req.path} from origin ${claimed ?? '(none)'}`);
        return res.status(403).json({ error: 'FORBIDDEN', message: 'Cross-site request blocked.' });
      }
    }

    // Anonymous session id for per-session rate limits (not an auth token)
    if (!sessionIdOf(req)) {
      const sid = randomBytes(16).toString('hex');
      res.append(
        'Set-Cookie',
        `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${production ? '; Secure' : ''}`
      );
      req.headers.cookie = `${req.headers.cookie ? `${req.headers.cookie}; ` : ''}${SESSION_COOKIE}=${sid}`;
    }
    next();
  };
}
