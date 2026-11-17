// MUST stay the first import so env is loaded before the Redis client is configured
import { getEnv, warnMissingKey } from './env.ts';
import { Redis } from '@upstash/redis';

// Read lazily (not captured at import time); placeholder values count as missing
const upstashUrl = () => getEnv('UPSTASH_REDIS_REST_URL');
const upstashToken = () => getEnv('UPSTASH_REDIS_REST_TOKEN');

let redisClient: Redis | null = null;
let redisInitialized = false;

export function getRedisClient(): Redis | null {
  if (redisInitialized) {
    return redisClient;
  }
  redisInitialized = true;

  const url = upstashUrl();
  const token = upstashToken();
  if (url && token) {
    try {
      redisClient = new Redis({ url, token });
      console.log('[Upstash Redis] Client initialized with endpoint:', url);
    } catch (err) {
      console.warn('[Upstash Redis] Initialization failed, will use fallback:', err);
      redisClient = null;
    }
  } else {
    if (!url) warnMissingKey('UPSTASH_REDIS_REST_URL', 'Redis cache');
    if (!token) warnMissingKey('UPSTASH_REDIS_REST_TOKEN', 'Redis cache');
    redisClient = null;
  }

  return redisClient;
}

export function isRedisConfigured(): boolean {
  return Boolean(upstashUrl() && upstashToken());
}

export async function checkRedisConnection(): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;
  try {
    const pong = await client.ping();
    return pong === 'PONG' || pong === 'OK' || Boolean(pong);
  } catch (err) {
    console.warn('[Upstash Redis] Ping check failed:', err);
    return false;
  }
}

