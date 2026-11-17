import { randomBytes } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import { getEnv } from './env.ts';
import {
  createLinkSession,
  describeDuffelError,
  getLiveOffer,
  getOrderSummary,
  isDuffelConfigured,
  markupConfig,
  searchDuffelOffers,
  validateSearch,
} from './duffelService.ts';
import {
  findReference,
  getBookingByReference,
  recordIssuedOrder,
  recordPendingBooking,
  verifyDuffelSignature,
} from './duffelBookings.ts';
import { fetchUlccFallback } from './ulccService.ts';
import { getRates } from './ratesService.ts';
import { applyDynamicMarkup, currencyDecimals, PricingError } from '../shared/pricing.ts';
import { ulccCarrier } from '../shared/ulcc.ts';
import type {
  CabinClass,
  CheckoutErrorResponse,
  CheckoutRequest,
  CheckoutResponse,
  FlightSearchRequest,
  FlightSearchResponse,
  UlccFallbackDto,
} from '../shared/flights.ts';

/**
 * Flight API on Duffel:
 *   POST /api/flights/search       offers (with our fee already in the price) + ULCC fallbacks
 *   POST /api/flights/checkout     re-validates the live offer, then opens a Duffel Links session
 *   GET  /api/flights/orders/:ref  booking status for the confirmation banner
 *   POST /api/webhooks/duffel      order.created: records the order id and the PNR (see below)
 */

const CABINS: CabinClass[] = ['economy', 'premium_economy', 'business', 'first'];

function appBaseUrl(req: Request): string {
  const configured = getEnv('APP_BASE_URL');
  if (configured) return configured.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? req.protocol;
  return `${proto}://${req.get('host')}`;
}

function fail(res: Response, status: number, body: CheckoutErrorResponse) {
  return res.status(status).json(body);
}

async function ulccFor(search: FlightSearchRequest): Promise<UlccFallbackDto[]> {
  if (search.slices.length > 2) return [];
  const [out, back] = search.slices;
  const fares = await fetchUlccFallback({
    origin: out.origin,
    destination: out.destination,
    date: out.departureDate,
    returnDate: back?.departureDate,
    legId: `leg-${out.origin.toLowerCase()}-${out.destination.toLowerCase()}`,
    hourlyRateUsd: 15,
  });
  return fares.flatMap((o) => {
    const carrier = ulccCarrier(o.carrierCode);
    if (!carrier || !o.affiliateUrl) return [];
    return [
      {
        source: 'external_ulcc' as const,
        carrier: { name: carrier.name, iataCode: carrier.code, ...(o.airlineLogo ? { logoUrl: o.airlineLogo } : {}) },
        affiliateUrl: o.affiliateUrl,
        priceUsd: o.basePriceUsd,
        slices: [
          {
            origin: { iataCode: o.segments?.[0]?.fromCode ?? out.origin, name: o.originStation },
            destination: { iataCode: o.segments?.at(-1)?.toCode ?? out.destination, name: o.destinationStation },
            departureAt: o.departureAt ?? out.departureDate,
          },
        ],
      },
    ];
  });
}

export function registerFlightRoutes(app: Express): void {
  app.post('/api/flights/search', async (req, res) => {
    const body = req.body as Partial<FlightSearchRequest> | undefined;
    const problem = validateSearch(body);
    if (problem) return res.status(400).json({ error: problem });
    if (body?.cabinClass && !CABINS.includes(body.cabinClass)) {
      return res.status(400).json({ error: `cabinClass must be one of ${CABINS.join(', ')}.` });
    }
    if (!isDuffelConfigured()) {
      return res.status(503).json({ error: 'Flight search is not configured (DUFFEL_ACCESS_TOKEN is missing).' });
    }
    const search = body as FlightSearchRequest;
    const [found, ulcc] = await Promise.all([searchDuffelOffers(search), ulccFor(search).catch(() => [])]);
    if (!found) return res.status(502).json({ error: 'The flight search failed. Try again shortly.' });
    const out: FlightSearchResponse = { offers: found.offers, ulcc, cached: found.cached };
    res.json(out);
  });

  app.post('/api/flights/checkout', async (req, res) => {
    const body = req.body as Partial<CheckoutRequest> | undefined;
    const offerId = String(body?.offerId ?? '');
    if (!/^off_[A-Za-z0-9]+$/.test(offerId)) {
      return fail(res, 400, { error: 'bad_request', message: 'offerId must be a Duffel offer id (off_…).' });
    }
    const passengers = Number(body?.passengers ?? 1);
    const expectedTotal = Number(body?.expectedTotal);
    if (!Number.isInteger(passengers) || passengers < 1 || passengers > 9 || !Number.isFinite(expectedTotal) || expectedTotal <= 0) {
      return fail(res, 400, { error: 'bad_request', message: 'passengers (1-9) and a positive expectedTotal are required.' });
    }
    if (!isDuffelConfigured()) {
      return fail(res, 503, { error: 'not_configured', message: 'Flight booking is not configured.' });
    }

    // 1. The offer must still exist and be bookable: airlines withdraw and expire offers
    const live = await getLiveOffer(offerId);
    if (live.status === 'expired' || live.status === 'not_found') {
      return fail(res, 410, { error: 'offer_expired', message: 'This fare is no longer available. Search again for current prices.' });
    }
    if (live.status === 'error') {
      console.warn('[Duffel] checkout offer lookup failed:', live.message);
      return fail(res, 502, { error: 'upstream_error', message: 'We could not confirm this fare with the airline. Try again.' });
    }

    // 2. Price it again here: the browser's number is only ever compared, never trusted
    let pricing;
    try {
      pricing = applyDynamicMarkup(live.offer.baseAmount, live.offer.currency, markupConfig(), (await getRates()).rates);
    } catch (err) {
      if (err instanceof PricingError) {
        return fail(res, 502, { error: 'upstream_error', message: 'This fare cannot be priced right now.' });
      }
      throw err;
    }
    const tolerance = 0.5 / 10 ** currencyDecimals(pricing.currency);
    const sameCurrency = String(body?.currency ?? '').toUpperCase() === pricing.currency;
    if (!sameCurrency || Math.abs(pricing.displayTotal - expectedTotal) > tolerance) {
      return fail(res, 409, {
        error: 'price_changed',
        message: 'The price changed since you searched. Review the new total to continue.',
        pricing,
      });
    }

    // 3. Hosted checkout: Duffel collects the passengers' details and payment and issues the ticket
    const reference = `astris_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
    const base = appBaseUrl(req);
    // Duffel Links only accepts public https return URLs (it rejects http://localhost)
    if (!/^https:\/\/[^/]+\./.test(base)) {
      console.warn(`[Duffel] checkout needs a public https return URL, got "${base}". Set APP_BASE_URL.`);
      return fail(res, 503, {
        error: 'not_configured',
        message: 'Checkout needs a public https address. Set APP_BASE_URL (for example https://your-domain.com).',
      });
    }
    const back = (state: string) => `${base}/?booking=${state}&ref=${reference}`;
    try {
      const checkoutUrl = await createLinkSession({
        reference,
        successUrl: back('success'),
        failureUrl: back('failed'),
        abandonmentUrl: back('abandoned'),
        // The fee is flat in the offer's currency, so it scales with the party
        markupAmount: Math.round(pricing.serviceFee * passengers * 100) / 100,
        markupCurrency: pricing.currency,
        logoUrl: getEnv('APP_LOGO_URL'),
        checkoutText: 'Booked through Astris Travel. The price includes the Astris service fee.',
      });
      await recordPendingBooking({ reference, offerId, pricing });
      const out: CheckoutResponse = { checkoutUrl, reference };
      res.json(out);
    } catch (err) {
      console.warn('[Duffel] Links session failed:', describeDuffelError(err));
      fail(res, 502, { error: 'upstream_error', message: 'Checkout could not be started. Try again.' });
    }
  });

  // The success redirect from Duffel Links carries `order_id` and our `reference`. The order is read
  // back from Duffel with our own token, so the PNR is recorded even if the webhook is late or
  // does not echo the reference.
  app.get('/api/flights/orders/:reference', async (req, res) => {
    const reference = String(req.params.reference);
    const orderId = String(req.query.order_id ?? '');
    let record = await getBookingByReference(reference);
    if (record?.status !== 'issued' && /^ord_[A-Za-z0-9]+$/.test(orderId) && /^astris_[a-z0-9]+$/i.test(reference) && record) {
      const order = await getOrderSummary(orderId);
      if (order) {
        record = await recordIssuedOrder({ orderId: order.id, bookingReference: order.bookingReference, reference });
      }
    }
    if (!record) return res.status(404).json({ error: 'Unknown booking reference.' });
    res.json({
      reference: record.reference,
      status: record.status,
      bookingReference: record.bookingReference,
      orderId: record.orderId,
    });
  });
}

/**
 * Must be registered BEFORE `express.json()`: the signature is over the raw bytes, so this route
 * parses the body itself.
 */
export function registerDuffelWebhook(app: Express): void {
  app.post('/api/webhooks/duffel', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const secret = getEnv('DUFFEL_WEBHOOK_SECRET');
    if (!secret) {
      console.warn('[Duffel] webhook received but DUFFEL_WEBHOOK_SECRET is not set; rejecting.');
      return res.status(503).json({ error: 'Webhook is not configured.' });
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!verifyDuffelSignature(raw, req.get('x-duffel-signature'), secret)) {
      return res.status(401).json({ error: 'Invalid signature.' });
    }
    let event: { type?: string; data?: { object?: { id?: string; booking_reference?: string } } };
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON.' });
    }
    if (event.type === 'order.created') {
      const order = event.data?.object;
      if (order?.id) {
        const record = await recordIssuedOrder({
          orderId: order.id,
          bookingReference: order.booking_reference,
          reference: findReference(event),
        });
        console.log(`[Duffel] order ${order.id} issued, PNR ${order.booking_reference ?? '?'} (ref ${record.reference})`);
      }
    }
    // Always acknowledge a verified event so Duffel does not keep retrying it
    res.json({ received: true });
  });
}
