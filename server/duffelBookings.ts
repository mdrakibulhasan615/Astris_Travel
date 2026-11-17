import { createHmac, timingSafeEqual } from 'node:crypto';
import { getRedisClient } from './redis.ts';
import type { PriceBreakdown } from '../shared/pricing.ts';

/**
 * Bookings made through Duffel Links. A pending record is written when the traveller is sent to the
 * hosted checkout; Duffel's `order.created` webhook then adds the order id and booking reference
 * (PNR) once the airline has issued the ticket. Kept in Upstash Redis for 30 days (and in memory).
 */

export interface BookingRecord {
  /** Our tracking reference, sent to Duffel as the Links session `reference`. */
  reference: string;
  status: 'pending' | 'issued';
  offerId?: string;
  pricing?: PriceBreakdown;
  createdAt: string;
  /** Set by the webhook. */
  orderId?: string;
  /** The PNR the airline issued. */
  bookingReference?: string;
  issuedAt?: string;
}

const TTL_SECONDS = 30 * 24 * 3600;
const memory = new Map<string, BookingRecord>();
const MEMORY_MAX = 500;

const refKey = (reference: string) => `duffel:booking:ref:${reference}`;
const orderKey = (orderId: string) => `duffel:booking:order:${orderId}`;

async function put(key: string, record: BookingRecord): Promise<void> {
  if (memory.size >= MEMORY_MAX) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(key, record);
  try {
    await getRedisClient()?.set(key, record, { ex: TTL_SECONDS });
  } catch (err) {
    console.warn(`[Duffel] could not store ${key}:`, err);
  }
}

async function get(key: string): Promise<BookingRecord | null> {
  const mem = memory.get(key);
  if (mem) return mem;
  try {
    return (await getRedisClient()?.get<BookingRecord>(key)) ?? null;
  } catch {
    return null;
  }
}

export async function recordPendingBooking(record: Omit<BookingRecord, 'status' | 'createdAt'>): Promise<void> {
  await put(refKey(record.reference), { ...record, status: 'pending', createdAt: new Date().toISOString() });
}

export async function getBookingByReference(reference: string): Promise<BookingRecord | null> {
  return get(refKey(reference));
}

/** Marks a booking issued (called from the webhook). The reference may be unknown for foreign orders. */
export async function recordIssuedOrder(input: {
  orderId: string;
  bookingReference?: string;
  reference?: string;
}): Promise<BookingRecord> {
  const existing = input.reference ? await getBookingByReference(input.reference) : null;
  const record: BookingRecord = {
    reference: input.reference ?? existing?.reference ?? input.orderId,
    ...existing,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    status: 'issued',
    orderId: input.orderId,
    bookingReference: input.bookingReference,
    issuedAt: new Date().toISOString(),
  };
  await put(orderKey(input.orderId), record);
  if (input.reference) await put(refKey(input.reference), record);
  return record;
}

// ── Webhook signature ────────────────────────────────────────────────────────────────────────────

/**
 * Verifies Duffel's `X-Duffel-Signature` header: `t=<unix seconds>,v1=<hex HMAC-SHA256>` where the
 * HMAC is over `<t>.<raw body>` with the webhook secret. Rejects signatures older than the tolerance
 * (replay protection). Pass the RAW body bytes, never re-serialised JSON.
 */
export function verifyDuffelSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string,
  toleranceSeconds = 300,
  nowMs = Date.now()
): boolean {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    })
  );
  const t = Number(parts.t);
  const sig = parts.v1;
  if (!Number.isFinite(t) || !sig || !/^[0-9a-f]+$/i.test(sig)) return false;
  if (Math.abs(nowMs / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  const given = Buffer.from(sig, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Finds our tracking reference anywhere in a webhook payload (Duffel nests it in order metadata). */
export function findReference(payload: unknown): string | undefined {
  return /astris_[a-z0-9]{8,40}/i.exec(JSON.stringify(payload ?? {}))?.[0];
}
