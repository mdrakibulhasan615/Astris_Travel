import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Ratelimit } from '@upstash/ratelimit';
import type { Redis } from '@upstash/redis';

/**
 * Sliding-window rate limits that keep bots from draining the SerpApi allowance (100 searches a
 * month on the free plan). Upstash Redis (`@upstash/ratelimit`) is used when it is configured, so the
 * limit holds across serverless instances; otherwise, or when Redis fails, an in-process sliding
 * window applies the same numbers per instance. Each request is counted against its IP and, when it
 * has one, its session cookie: whichever runs out first answers `429` with `Retry-After`.
 */

export interface LimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  /** Epoch ms when a slot frees up. */
  reset: number;
}

export interface Limiter {
  limit(key: string): Promise<LimitResult>;
}

/** Exact sliding window (timestamp log) in memory. Bounded: old keys are evicted. */
export function createMemoryLimiter(opts: { max: number; windowMs: number; now?: () => number; maxKeys?: number }): Limiter {
  const { max, windowMs, now = Date.now, maxKeys = 10_000 } = opts;
  const hits = new Map<string, number[]>();
  return {
    async limit(key) {
      const t = now();
      const since = t - windowMs;
      const log = (hits.get(key) ?? []).filter((ts) => ts > since);
      if (log.length >= max) {
        hits.set(key, log);
        return { success: false, limit: max, remaining: 0, reset: log[0] + windowMs };
      }
      log.push(t);
      hits.delete(key); // re-insert so Map order tracks recency for eviction
      hits.set(key, log);
      if (hits.size > maxKeys) {
        const oldest = hits.keys().next().value;
        if (oldest !== undefined) hits.delete(oldest);
      }
      return { success: true, limit: max, remaining: max - log.length, reset: (log[0] ?? t) + windowMs };
    },
  };
}

export interface RateLimitRule {
  /** Name, used in the Redis prefix and logs. */
  name: string;
  max: number;
  windowSeconds: number;
}

/** Upstash when `redis()` returns a client, memory otherwise; a Redis error falls back to memory. */
export function createLimiter(rule: RateLimitRule, redis?: () => Redis | null, now?: () => number): Limiter {
  const memory = createMemoryLimiter({ max: rule.max, windowMs: rule.windowSeconds * 1000, now });
  let upstash: Ratelimit | null | undefined;
  const getUpstash = () => {
    if (upstash !== undefined) return upstash;
    const client = redis?.() ?? null;
    upstash = client
      ? new Ratelimit({
          redis: client,
          limiter: Ratelimit.slidingWindow(rule.max, `${rule.windowSeconds} s`),
          prefix: `astris:rl:${rule.name}`,
          analytics: false,
          timeout: 1500, // a slow Redis must not block the request; it fails open to memory below
        })
      : null;
    return upstash;
  };
  return {
    async limit(key) {
      const rl = getUpstash();
      if (rl) {
        try {
          const r = await rl.limit(key);
          return { success: r.success, limit: r.limit, remaining: r.remaining, reset: r.reset };
        } catch (err) {
          console.warn(`[RateLimit] Redis failed for ${rule.name}, using memory:`, (err as Error)?.message ?? err);
        }
      }
      return memory.limit(key);
    },
  };
}

export const SESSION_COOKIE = 'astris_sid';

/** The anonymous session id from the `astris_sid` cookie (set by `securityMiddleware`). */
export function sessionIdOf(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const m = header.match(/(?:^|;\s*)astris_sid=([A-Za-z0-9_-]{16,64})(?:;|$)/);
  return m ? m[1] : null;
}

/** Client IP. `trust proxy` is set on the app, so `req.ip` reads the proxy's X-Forwarded-For. */
export function clientIp(req: Request): string {
  return (req.ip || req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

/**
 * Express middleware: counts the request against `ip:<addr>` and `sid:<cookie>` and answers
 * `429 Too Many Requests` (JSON body, `Retry-After` seconds, `RateLimit-*` headers) when either is spent.
 */
export function rateLimit(rule: RateLimitRule, limiter: Limiter): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const keys = [`ip:${clientIp(req)}`];
      const sid = sessionIdOf(req);
      if (sid) keys.push(`sid:${sid}`);
      const results = await Promise.all(keys.map((k) => limiter.limit(k)));
      const blocked = results.find((r) => !r.success);
      const tightest = blocked ?? results.reduce((a, b) => (b.remaining < a.remaining ? b : a));
      res.setHeader('RateLimit-Limit', String(rule.max));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, tightest.remaining)));
      res.setHeader('RateLimit-Reset', String(Math.max(0, Math.ceil((tightest.reset - Date.now()) / 1000))));
      if (blocked) {
        const retryAfter = Math.max(1, Math.ceil((blocked.reset - Date.now()) / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        console.warn(`[RateLimit] ${rule.name} exceeded by ${keys.join(' ')} (retry in ${retryAfter}s)`);
        return res.status(429).json({
          error: 'RATE_LIMITED',
          message: `Too many requests. Try again in ${retryAfter} seconds.`,
          retryAfter,
        });
      }
      next();
    } catch (err) {
      // A limiter bug must not take the endpoint down
      console.warn(`[RateLimit] ${rule.name} check failed:`, (err as Error)?.message ?? err);
      next();
    }
  };
}

/** The limits on endpoints that spend provider quota or send email. */
export const RATE_LIMITS = {
  liveSearch: { name: 'live-search', max: 5, windowSeconds: 600 },
  returnFlights: { name: 'return-flights', max: 10, windowSeconds: 600 },
  bookingOptions: { name: 'booking-options', max: 15, windowSeconds: 600 },
  hotels: { name: 'hotels', max: 10, windowSeconds: 600 },
  authEmail: { name: 'auth-email', max: 5, windowSeconds: 600 },
  routesWrite: { name: 'routes-write', max: 60, windowSeconds: 600 },
} satisfies Record<string, RateLimitRule>;
