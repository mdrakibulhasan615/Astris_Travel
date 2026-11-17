/**
 * URL guard for links and form actions built from provider data (SerpApi `booking_request.url`,
 * airline logos, etc.). Only absolute `https:` URLs pass: `javascript:`, `data:`, `vbscript:`,
 * `blob:`, `file:`, plain `http:`, protocol-relative (`//evil`) and relative URLs are all refused,
 * so a hostile or malformed upstream value can never become an executable `href` / `action`.
 *
 * Pure TypeScript, imported by both the server (when parsing provider answers) and the browser
 * (again, right before rendering: defence in depth).
 */

const MAX_URL_LENGTH = 4096;
const ALLOWED_PROTOCOLS = new Set(['https:']);
// Control characters and whitespace that browsers strip or tolerate inside a scheme ("java\tscript:")
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F\s]/;

/** The normalised URL when it is an absolute https URL with a host, otherwise `null`. */
export function safeHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > MAX_URL_LENGTH || CONTROL_RE.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null; // relative or unparsable
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  if (!url.hostname || url.username || url.password) return null;
  return url.toString();
}

/** True when `raw` passes {@link safeHttpsUrl}. */
export function isSafeHttpsUrl(raw: unknown): raw is string {
  return safeHttpsUrl(raw) !== null;
}
