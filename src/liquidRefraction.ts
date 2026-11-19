/**
 * Edge refraction for glass surfaces: an SVG displacement filter used as `backdrop-filter: url(#…)`.
 * The map is neutral in the middle and ramps up over a band along every edge, pointing inwards, so
 * the background seen near a glass edge is pulled in and bent, like looking through the rim of a lens,
 * while the centre stays undistorted.
 *
 * A displacement filter works in pixels, so each surface size gets its own filter (sizes rounded to
 * 4px and cached). Only Chromium-based browsers apply SVG filters to the backdrop; everywhere else
 * `refraction()` returns null and glass stays a plain frosted blur.
 */

const NS = 'http://www.w3.org/2000/svg';
const MAX_FILTERS = 240;

let defs: SVGDefsElement | null = null;
let supported: boolean | null = null;
const filters = new Map<string, { url: string; node: SVGFilterElement }>();

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function refractionSupported(): boolean {
  if (supported !== null) return supported;
  if (typeof window === 'undefined') return (supported = false);
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands;
  const chromium = !!brands?.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand));
  const reduce = window.matchMedia('(prefers-reduced-transparency: reduce)').matches;
  return (supported = chromium && !reduce);
}

function host(): SVGDefsElement {
  if (defs?.isConnected) return defs;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.style.pointerEvents = 'none';
  defs = document.createElementNS(NS, 'defs');
  svg.appendChild(defs);
  document.body.appendChild(svg);
  return defs;
}

/** The displacement map: red = sideways pull, green = vertical pull, 128 = none. */
function mapUri(w: number, h: number, band: number): string {
  const fx = Math.min(0.45, band / w);
  const fy = Math.min(0.45, band / h);
  // Left/top edges sample from further in (255), right/bottom edges from further in the other way (0)
  const stops = (f: number, ch: (v: number) => string) =>
    `<stop offset='0' stop-color='${ch(255)}'/>` +
    `<stop offset='${(f * 0.45).toFixed(4)}' stop-color='${ch(188)}'/>` +
    `<stop offset='${f.toFixed(4)}' stop-color='${ch(128)}'/>` +
    `<stop offset='${(1 - f).toFixed(4)}' stop-color='${ch(128)}'/>` +
    `<stop offset='${(1 - f * 0.45).toFixed(4)}' stop-color='${ch(68)}'/>` +
    `<stop offset='1' stop-color='${ch(0)}'/>`;
  const svg =
    `<svg xmlns='${NS}' width='${w}' height='${h}'><defs>` +
    `<linearGradient id='x' x1='0' y1='0' x2='1' y2='0'>${stops(fx, (v) => `rgb(${v},0,0)`)}</linearGradient>` +
    `<linearGradient id='y' x1='0' y1='0' x2='0' y2='1'>${stops(fy, (v) => `rgb(0,${v},0)`)}</linearGradient>` +
    `</defs><rect width='100%' height='100%' fill='url(#x)'/>` +
    `<rect width='100%' height='100%' fill='url(#y)' style='mix-blend-mode:screen'/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * `url(#…)` of a refraction filter for a surface of this size, or null where unsupported. `strength`
 * scales how hard the edges bend (1 for glass panels; less over text, so labels stay readable).
 */
export function refraction(width: number, height: number, strength = 1): string | null {
  if (!refractionSupported() || width < 8 || height < 8) return null;
  const w = Math.round(width / 4) * 4;
  const h = Math.round(height / 4) * 4;
  const k = Math.round(strength * 10) / 10;
  const key = `${w}x${h}-${k}`;
  const hit = filters.get(key);
  if (hit?.node.isConnected) return hit.url;

  const short = Math.min(w, h);
  const band = clamp(short * 0.38, 6, 40); // how far in from the edge the bending reaches
  const scale = clamp(short * 0.5, 10, 56) * k; // how strongly it bends at the very edge

  const id = `lg-refract-${key.replace('.', '_')}`;
  const filter = document.createElementNS(NS, 'filter');
  filter.setAttribute('id', id);
  filter.setAttribute('x', '0');
  filter.setAttribute('y', '0');
  filter.setAttribute('width', String(w));
  filter.setAttribute('height', String(h));
  filter.setAttribute('filterUnits', 'userSpaceOnUse');
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  const image = document.createElementNS(NS, 'feImage');
  image.setAttribute('href', mapUri(w, h, band));
  image.setAttribute('x', '0');
  image.setAttribute('y', '0');
  image.setAttribute('width', String(w));
  image.setAttribute('height', String(h));
  image.setAttribute('preserveAspectRatio', 'none');
  image.setAttribute('result', 'map');
  const displace = document.createElementNS(NS, 'feDisplacementMap');
  displace.setAttribute('in', 'SourceGraphic');
  displace.setAttribute('in2', 'map');
  displace.setAttribute('scale', scale.toFixed(1));
  displace.setAttribute('xChannelSelector', 'R');
  displace.setAttribute('yChannelSelector', 'G');
  filter.append(image, displace);
  host().appendChild(filter);

  const url = `url(#${id})`;
  filters.set(key, { url, node: filter });
  if (filters.size > MAX_FILTERS) {
    const [oldKey, old] = filters.entries().next().value as [string, { node: SVGFilterElement }];
    old.node.remove();
    filters.delete(oldKey);
  }
  return url;
}

/** Glass surfaces that get edge refraction (sized from their layout box, so transforms don't matter). */
const GLASS = '.glass, .glass-strong, .glass-chrome, .glass-control, .glass-dark';

/** Keeps every glass surface's `--lg-refract` filter in step with its size. Returns a cleanup. */
export function watchGlassRefraction(): () => void {
  if (!refractionSupported()) return () => {};
  document.documentElement.classList.add('lg-refract');

  const apply = (el: HTMLElement) => {
    const url = el.offsetWidth <= 1800 ? refraction(el.offsetWidth, el.offsetHeight) : null;
    if (url) el.style.setProperty('--lg-refract', url);
    else el.style.removeProperty('--lg-refract');
  };
  const seen = new WeakSet<Element>();
  const resize = new ResizeObserver((entries) => entries.forEach((e) => apply(e.target as HTMLElement)));
  const scan = () => {
    document.querySelectorAll<HTMLElement>(GLASS).forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      resize.observe(el);
      apply(el);
    });
  };
  let queued = 0;
  const mutations = new MutationObserver(() => {
    if (queued) return;
    queued = requestAnimationFrame(() => {
      queued = 0;
      scan();
    });
  });
  scan();
  mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  return () => {
    mutations.disconnect();
    resize.disconnect();
    cancelAnimationFrame(queued);
    document.documentElement.classList.remove('lg-refract');
  };
}
