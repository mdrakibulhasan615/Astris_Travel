import { z } from 'zod';
import type { LiveSearchRequest } from '../../shared/liveFlights.ts';
import { isIsoDate } from '../../shared/savedRoutes.ts';

export { isIsoDate, routeImportSchema, savedRouteSchema, clientIdSchema } from '../../shared/savedRoutes.ts';

/**
 * Strict request schemas for every endpoint that spends provider quota or writes user data.
 * Anything not described here is rejected (or stripped) before a handler sees it.
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** Upper-cased after trimming, so `kul` is accepted as `KUL`; anything else must be exactly 3 letters. */
export const iataSchema = z.string().max(8).trim().toUpperCase().regex(/^[A-Z]{3}$/, 'must be a 3-letter IATA code');
export const isoDateSchema = z.string().max(10).refine(isIsoDate, 'must be a valid YYYY-MM-DD date');
export const currencySchema = z.string().max(8).trim().toUpperCase().regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO code');
export const adultsSchema = z.coerce.number().int().min(1).max(9);
/** Opaque SerpApi tokens: bounded, printable, no whitespace or markup. */
export const providerTokenSchema = z.string().min(8).max(8192).regex(/^[A-Za-z0-9+/=_\-.:%]+$/, 'is malformed');

const optionalReturnDate = z.preprocess((v) => (v === null || v === '' ? undefined : v), isoDateSchema.optional());

export const liveSearchSchema = z
  .object({
    originIata: iataSchema,
    destinationIata: iataSchema,
    departureDate: isoDateSchema,
    returnDate: optionalReturnDate,
    adults: adultsSchema.optional().default(1),
    currency: currencySchema.optional().default('USD'),
    // Scoring hints (sanitised again by the handler)
    hourlyRateUsd: z.coerce.number().min(0).max(1000).optional(),
    passengers: z.coerce.number().int().min(1).max(9).optional(),
  })
  .refine((b) => b.originIata !== b.destinationIata, { message: 'Origin and destination must differ.' })
  .refine((b) => !b.returnDate || b.returnDate >= b.departureDate, {
    message: 'returnDate must not be before departureDate.',
    path: ['returnDate'],
  });

export const returnFlightsSchema = z.intersection(liveSearchSchema, z.object({ departureToken: providerTokenSchema }));

export const bookingOptionsSchema = z.object({
  bookingToken: providerTokenSchema,
  currency: currencySchema.optional().default('USD'),
  search: liveSearchSchema,
});

/** First issue as a one-line message (`originIata: must be a 3-letter IATA code`). */
export function zodMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid request.';
  const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
  return `${where}${issue.message}`;
}

export function parseWith<T>(schema: z.ZodType<T>, body: unknown): Parsed<T> {
  const r = schema.safeParse(body ?? undefined);
  return r.success ? { ok: true, value: r.data } : { ok: false, message: zodMessage(r.error) };
}

/** Validates and normalises a live-search body (also the `search` of a booking-options body). */
export function parseLiveSearch(body: unknown): Parsed<LiveSearchRequest> {
  const r = parseWith(liveSearchSchema, body);
  if (!r.ok) return r;
  const { originIata, destinationIata, departureDate, returnDate, adults, currency } = r.value;
  return { ok: true, value: { originIata, destinationIata, departureDate, returnDate, adults, currency } };
}

// ── Accounts & saved routes ─────────────────────────────────────────────────────────────────────

export const emailSchema = z.object({ email: z.string().trim().toLowerCase().max(254).email() });
export const otpVerifySchema = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
  token: z.string().trim().regex(/^\d{6,10}$/, 'must be the code from the email'),
});

/** Only a relative, same-site path may be a post-login destination (no open redirects). */
export function safeNextPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (raw.length > 512 || /[\u0000-\u001F]/.test(raw)) return '/';
  return raw;
}

