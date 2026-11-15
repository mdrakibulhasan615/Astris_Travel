import { getRedisClient } from './transitService.ts';

/**
 * Small generic JSON cache for responses that rarely change (timetables, transit directions):
 * Upstash Redis when configured, plus an in-process copy. Failures are logged and ignored; a cache
 * problem must never break a request.
 */

export const SCHEDULE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

const MEMORY_MAX = 300;
const memory = new Map<string, { expires: number; value: unknown }>();

export async function getJson<T>(key: string): Promise<T | null> {
  const hit = memory.get(key);
  if (hit) {
    if (hit.expires > Date.now()) return hit.value as T;
    memory.delete(key);
  }
  const client = getRedisClient();
  if (!client) return null;
  try {
    const value = await client.get<T>(key);
    if (value !== null && value !== undefined) {
      remember(key, value);
      return value;
    }
  } catch (err) {
    console.warn(`[Cache] Redis read failed for "${key}":`, err);
  }
  return null;
}

export async function setJson(key: string, value: unknown, ttlSeconds = SCHEDULE_CACHE_TTL_SECONDS): Promise<void> {
  remember(key, value, ttlSeconds);
  const client = getRedisClient();
  if (!client) return;
  try {
    await client.set(key, value, { ex: ttlSeconds });
  } catch (err) {
    console.warn(`[Cache] Redis write failed for "${key}":`, err);
  }
}

function remember(key: string, value: unknown, ttlSeconds = SCHEDULE_CACHE_TTL_SECONDS): void {
  if (memory.size >= MEMORY_MAX) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(key, { expires: Date.now() + ttlSeconds * 1000, value });
}
