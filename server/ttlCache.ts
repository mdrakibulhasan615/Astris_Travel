/**
 * A small TTL cache: Upstash Redis first when it is configured (so a serverless cold start does not
 * spend quota on an answer another instance already fetched), with an in-process Map as the fallback
 * for local development and for when Redis is down. Failures in Redis never fail a request.
 */

/** The slice of the Upstash client this cache uses. */
export interface RedisLike {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts: { ex: number }): Promise<unknown>;
}

export interface TtlCacheOptions {
  ttlSeconds: number;
  /** Returns the Redis client, or null when it is not configured. Read on every call. */
  redis?: () => RedisLike | null;
  maxEntries?: number;
  /** Injectable clock (ms), for tests. */
  now?: () => number;
}

export interface CacheHit<T> {
  value: T;
  layer: 'memory' | 'redis';
}

export interface TtlCache<T> {
  get(key: string): Promise<CacheHit<T> | null>;
  set(key: string, value: T): Promise<void>;
}

export function createTtlCache<T>(opts: TtlCacheOptions): TtlCache<T> {
  const { ttlSeconds, maxEntries = 200, now = Date.now } = opts;
  const memory = new Map<string, { expires: number; value: T }>();

  const remember = (key: string, value: T) => {
    if (memory.size >= maxEntries && !memory.has(key)) {
      const oldest = memory.keys().next().value;
      if (oldest !== undefined) memory.delete(oldest);
    }
    memory.set(key, { expires: now() + ttlSeconds * 1000, value });
  };

  return {
    async get(key) {
      const hit = memory.get(key);
      if (hit) {
        if (hit.expires > now()) return { value: hit.value, layer: 'memory' };
        memory.delete(key);
      }
      const redis = opts.redis?.();
      if (!redis) return null;
      try {
        const stored = await redis.get<T>(key);
        if (stored !== null && stored !== undefined) {
          remember(key, stored);
          return { value: stored, layer: 'redis' };
        }
      } catch (err) {
        console.warn(`[Cache] Redis read failed for ${key}:`, (err as Error)?.message ?? err);
      }
      return null;
    },

    async set(key, value) {
      remember(key, value);
      const redis = opts.redis?.();
      if (!redis) return;
      try {
        await redis.set(key, value, { ex: ttlSeconds });
      } catch (err) {
        console.warn(`[Cache] Redis write failed for ${key}:`, (err as Error)?.message ?? err);
      }
    },
  };
}

/**
 * Returns the cached value, or runs `fetcher` once and caches its result. `cached` says which
 * happened (a miss is the one case that spends provider quota). Errors from `fetcher` are not cached.
 */
export async function getOrFetch<T>(
  cache: TtlCache<T>,
  key: string,
  fetcher: () => Promise<T>
): Promise<{ value: T; cached: boolean }> {
  const hit = await cache.get(key);
  if (hit) return { value: hit.value, cached: true };
  const value = await fetcher();
  await cache.set(key, value);
  return { value, cached: false };
}
