/**
 * Brand marks for airlines and sellers. They are fetched from public image hosts (never bundled), and
 * every use has a drawn fallback for when an image is blocked or missing.
 */

/**
 * An airline's small symbol logo (its tail or emblem, not the full wordmark, which is unreadable at
 * icon size): the one the fare data carried (SerpApi sends one per flight), else the same Google
 * Flights logo set by IATA code, so live and estimated tickets look alike. Undefined when neither.
 */
export function airlineLogoUrl(code?: string | null, hint?: string | null): string | undefined {
  if (hint) return hint;
  const c = (code ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{2}$/.test(c) ? `https://www.gstatic.com/flights/airline_logos/70px/${c}.png` : undefined;
}

/** The site each comparison-panel merchant badge stands for. */
const MERCHANT_DOMAINS: Record<string, string> = {
  aviasales: 'aviasales.com',
  tripcom: 'trip.com',
  'trip-hotels': 'trip.com',
  kiwi: 'kiwi.com',
  skyscanner: 'skyscanner.net',
  'google-flights': 'google.com',
  'google-hotels': 'google.com',
  booking: 'booking.com',
  agoda: 'agoda.com',
};

/** A merchant's logo (its site's own icon), or undefined for a merchant we do not know. */
export function merchantLogoUrl(id: string): string | undefined {
  const domain = MERCHANT_DOMAINS[id];
  return domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : undefined;
}
