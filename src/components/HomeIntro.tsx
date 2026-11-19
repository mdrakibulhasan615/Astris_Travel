import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Plus } from 'lucide-react';
import type { TripStop } from '../../shared/types.ts';

/**
 * The home page: the route bar alone on a dark backdrop. The first keystroke sets it off:
 * the bar breaks into a chain of segments that slithers around the screen like a snake, does a
 * barrel roll through a loop, and lands exactly on the planner's route bar, while the home page
 * lifts away to reveal the planner underneath. Typing carries straight on in "Add a stop…".
 *
 * The flight is one requestAnimationFrame loop writing transforms to N plain divs (no React
 * renders per frame). Each segment sits at a point along one path, measured by arc length: the
 * home bar's centreline, a Catmull-Rom curve through a few waypoints (with a loop), then the
 * target bar's centreline. Reduced motion skips the flight and simply fades the page away.
 */

interface HomeIntroProps {
  /** Shown as pills before the input, exactly like the planner's route bar. */
  stops: TripStop[];
  /** The first character was typed: show the map (on phones) so the route bar can be measured. */
  onStart: () => void;
  /** The snake is about to land: fade the real route bar in under it. */
  onReveal: () => void;
  /** Finished: unmount the home page and hand over what was typed. */
  onDone: (text: string) => void;
}

const SEGMENTS = 44;
const DURATION_MS = 2800;
const LIFT_DELAY_S = 0.35;
const ORANGE = '#FF812E';

type Pt = { x: number; y: number };

interface Path {
  length: number;
  at: (s: number) => { x: number; y: number; angle: number };
}

/** Samples straight start line + Catmull-Rom through the waypoints + straight end line. */
function buildPath(points: Pt[]): Path {
  const samples: Pt[] = [points[0]];
  // points[0]→points[1] and the last pair are straight lines; the rest is a smooth curve
  samples.push(points[1]);
  for (let i = 1; i < points.length - 2; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2];
    const steps = 32;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      samples.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  samples.push(points[points.length - 1]);

  const cum = [0];
  for (let i = 1; i < samples.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y));
  }
  const length = cum[cum.length - 1];

  const at = (s: number) => {
    const d = Math.max(0, Math.min(length, s));
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const a = samples[lo];
    const b = samples[hi];
    const span = cum[hi] - cum[lo] || 1;
    const k = (d - cum[lo]) / span;
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, angle: Math.atan2(b.y - a.y, b.x - a.x) };
  };
  return { length, at };
}

/** Arc length of the sample nearest to `p` (used to find where the loop starts and ends). */
function arcLengthNear(path: Path, p: Pt): number {
  let best = 0;
  let bestD = Infinity;
  for (let s = 0; s <= path.length; s += 4) {
    const q = path.at(s);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Gets going quickly, glides, then settles gently onto the route bar. */
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

function targetRect(): DOMRect {
  const el = document.querySelector<HTMLElement>('[data-route-bar="map"]');
  const r = el?.getBoundingClientRect();
  if (r && r.width > 0 && r.height > 0) return r;
  // No map on screen: land at the top of the page instead
  const w = Math.min(window.innerWidth - 32, 720);
  return new DOMRect((window.innerWidth - w) / 2, 72, w, 44);
}

export function HomeIntro({ stops, onStart, onReveal, onDone }: HomeIntroProps) {
  const reduce = useReducedMotion();
  const [stage, setStage] = useState<'home' | 'flying'>('home');
  const [value, setValue] = useState('');
  const valueRef = useRef('');
  const barRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const segRefs = useRef<(SVGLineElement | null)[]>([]);
  const stripeRef = useRef<SVGPolylineElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const callbacks = useRef({ onStart, onReveal, onDone });
  callbacks.current = { onStart, onReveal, onDone };

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  // The flight
  useEffect(() => {
    if (stage !== 'flying') return;
    callbacks.current.onStart();
    let raf = 0;
    let revealed = false;

    if (reduce) {
      callbacks.current.onReveal();
      const t = window.setTimeout(() => callbacks.current.onDone(valueRef.current), 450);
      return () => window.clearTimeout(t);
    }

    // Wait two frames so the map (shown by onStart on phones) has laid out before measuring
    raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        const bar = barRef.current?.getBoundingClientRect();
        if (!bar) return callbacks.current.onDone(valueRef.current);
        const tgt = targetRect();
        const W = window.innerWidth;
        const H = window.innerHeight;
        const m = Math.min(W, H);
        const cy = bar.top + bar.height / 2;
        const ty = tgt.top + tgt.height / 2;

        // The tour: out to the right and down, a wave across the bottom, up into a loop (the barrel
        // roll), then in from the left onto the route bar
        const loopC = { x: 0.5 * W, y: 0.5 * H };
        const r = 0.14 * m;
        const loopIn = { x: loopC.x - r, y: loopC.y };
        const loopOut = { x: loopC.x - r * 0.15, y: loopC.y + r };
        const points: Pt[] = [
          // Round line caps add half the thickness at each end, so the lines are inset by that much
          { x: bar.left + bar.height / 2, y: cy },
          { x: bar.right - bar.height / 2, y: cy },
          { x: Math.min(W - 70, bar.right + 0.1 * W), y: Math.min(H - 60, cy + 0.2 * H) },
          { x: 0.68 * W, y: 0.86 * H },
          { x: 0.42 * W, y: 0.72 * H },
          { x: 0.2 * W, y: 0.82 * H },
          { x: 0.14 * W, y: 0.6 * H },
          loopIn,
          { x: loopC.x, y: loopC.y - r },
          { x: loopC.x + r, y: loopC.y },
          loopOut,
          { x: loopC.x - r * 1.1, y: loopC.y + r * 0.2 },
          // Not clamped on-screen: when the bar starts near the left edge (phones) the snake swings
          // in from just off-screen rather than doubling back on itself
          { x: tgt.left - Math.max(60, 0.12 * W), y: ty + Math.min(80, 0.08 * H) },
          { x: tgt.left - 30, y: ty },
          { x: tgt.left + tgt.height / 2, y: ty },
          { x: tgt.right - tgt.height / 2, y: ty },
        ];
        const path = buildPath(points);
        const rollStart = arcLengthNear(path, loopIn);
        const rollEnd = Math.max(rollStart + 1, arcLengthNear(path, loopOut));
        const startLen = bar.width - bar.height;
        const endLen = tgt.width - tgt.height;
        const startHead = startLen;
        const t0 = performance.now();

        const frame = (now: number) => {
          const p = clamp01((now - t0) / DURATION_MS);
          const e = easeInOut(p);
          const mid = Math.sin(Math.PI * e); // 0 at both ends, 1 mid-flight
          const head = lerp(startHead, path.length, e);
          // The bar's length becomes the body length; it shortens mid-flight into a proper snake
          const bodyLen = (k: number) => lerp(startLen, endLen, k) * (1 - 0.45 * Math.sin(Math.PI * k));
          const thick = lerp(bar.height, tgt.height, e) * (1 - 0.5 * mid);
          const fade = 1 - clamp01((p - 0.9) / 0.1);
          // The planner can still be settling (fonts, data, the phone layout switch), so follow the
          // route bar's live position: blend the whole path onto it over the second half of the flight
          const live = targetRect();
          const follow = clamp01((e - 0.5) / 0.5);
          const settle = follow * follow * (3 - 2 * follow);
          const dx = (live.left - tgt.left) * settle;
          const dy = (live.top + live.height / 2 - ty) * settle;
          const dw = (live.width - tgt.width) * settle;
          const lineStart = path.length - endLen;

          // Points along the body, head first. Each one also wiggles side to side (the slither),
          // strongest mid-flight and gone at both ends so the bar starts and lands straight.
          const body: { x: number; y: number; h: number; tint: number }[] = [];
          const stripe: string[] = [];
          const t = now - t0;
          for (let i = 0; i <= SEGMENTS; i++) {
            const k = i / SEGMENTS;
            const sAt = head - k * bodyLen(e);
            const pt = path.at(sAt);
            const wiggle = Math.sin(sAt / 70 - t / 140) * 22 * mid * (0.4 + 0.6 * k);
            const nx = -Math.sin(pt.angle);
            const ny = Math.cos(pt.angle);
            // On the final straight, stretch to the bar's live width as well
            const stretch = sAt > lineStart ? ((sAt - lineStart) / Math.max(1, endLen)) * dw : 0;
            const x = pt.x + nx * wiggle + dx + stretch;
            const y = pt.y + ny * wiggle + dy;
            const h = thick * (1 - 0.55 * k * mid);
            body.push({ x, y, h, tint: Math.round(100 * mid * (1 - 0.75 * k)) });
            // Barrel roll: the stripe along the back turns round the body as it passes the loop
            const roll = sAt <= rollStart ? 0 : sAt >= rollEnd ? 1 : (sAt - rollStart) / (rollEnd - rollStart);
            const off = -Math.cos(roll * Math.PI * 2) * h * 0.28;
            stripe.push(`${(x + nx * off).toFixed(1)},${(y + ny * off).toFixed(1)}`);
          }
          for (let i = 0; i < SEGMENTS; i++) {
            const el = segRefs.current[i];
            if (!el) continue;
            const p1 = body[i];
            const p2 = body[i + 1];
            el.setAttribute('x1', p1.x.toFixed(1));
            el.setAttribute('y1', p1.y.toFixed(1));
            el.setAttribute('x2', p2.x.toFixed(1));
            el.setAttribute('y2', p2.y.toFixed(1));
            el.setAttribute('stroke-width', ((p1.h + p2.h) / 2).toFixed(1));
            el.style.stroke = `color-mix(in srgb, ${ORANGE} ${p1.tint}%, white)`;
          }
          stripeRef.current?.setAttribute('points', stripe.join(' '));
          stripeRef.current?.setAttribute('stroke-width', Math.max(1.5, thick * 0.14).toFixed(1));
          stripeRef.current?.setAttribute('opacity', String(0.9 * mid));
          if (svgRef.current) svgRef.current.style.opacity = String(fade);

          if (!revealed && p >= 0.86) {
            revealed = true;
            callbacks.current.onReveal();
          }
          if (p < 1) raf = requestAnimationFrame(frame);
          else callbacks.current.onDone(valueRef.current);
        };
        raf = requestAnimationFrame(frame);
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [stage, reduce]);

  const flying = stage === 'flying';

  return (
    <>
      {/* The page itself: lifts away once the bar takes off */}
      <motion.div
        role="region"
        aria-label="Astris Travel home"
        className="fixed inset-0 z-[80] flex items-center justify-center overflow-hidden bg-[#0B1220] px-4"
        initial={false}
        animate={
          flying
            ? reduce
              ? { opacity: 0, transition: { duration: 0.4 } }
              : { y: '-100%', borderBottomLeftRadius: 48, borderBottomRightRadius: 48, transition: { delay: LIFT_DELAY_S, duration: 1.1, ease: [0.7, 0, 0.2, 1] } }
            : { y: 0 }
        }
        style={{ boxShadow: flying ? '0 30px 80px rgba(0,0,0,0.45)' : undefined }}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(60% 50% at 50% 40%, rgba(255,129,46,0.18), transparent 70%), radial-gradient(50% 60% at 80% 90%, rgba(59,130,246,0.14), transparent 70%)',
          }}
        />
        <motion.div
          ref={barRef}
          role="group"
          aria-label="Trip route"
          className="relative flex w-[min(94vw,920px)] items-center gap-1 rounded-2xl border border-white/50 bg-white/90 p-1.5 pl-2 shadow-2xl backdrop-blur-md"
          initial={reduce ? false : { opacity: 0, y: 16, scale: 0.96 }}
          animate={{ opacity: flying && !reduce ? 0 : 1, y: 0, scale: 1 }}
          transition={flying ? { duration: 0.05 } : { duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* Same look as the planner's route bar (RouteBar.tsx), so the landing is seamless */}
          <ol aria-label="Stops in order" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-1.5 py-0.5">
            {stops.map((stop, i) => (
              <li key={stop.id} className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-neutral-200 bg-white pl-1.5 pr-2 text-xs shadow-sm">
                <span
                  aria-hidden="true"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#FF812E] font-mono text-[10px] font-bold text-white"
                >
                  {i + 1}
                </span>
                <span className="max-w-[9rem] truncate font-semibold text-[#111827]">{stop.city}</span>
              </li>
            ))}
            <li className="ml-1 shrink-0">
              <div className="flex h-8 items-center gap-1.5 rounded-full border border-dashed border-neutral-300 bg-white/70 pl-2.5 pr-3 focus-within:border-[#FF812E]">
                <Plus className="h-3.5 w-3.5 text-[#6B7280]" aria-hidden="true" />
                <label htmlFor="home-destination" className="sr-only">
                  Add a stop
                </label>
                <input
                  id="home-destination"
                  ref={inputRef}
                  value={value}
                  autoComplete="off"
                  onChange={(e) => {
                    const v = e.target.value;
                    setValue(v);
                    valueRef.current = v;
                    if (v.trim() && stage === 'home') setStage('flying');
                  }}
                  onKeyDown={(e) => {
                    // Escape skips straight to the planner
                    if (e.key === 'Escape' && stage === 'home') setStage('flying');
                  }}
                  placeholder="Add a stop…"
                  className="w-36 bg-transparent text-xs text-[#111827] placeholder:text-[#6B7280] focus:outline-none"
                />
              </div>
            </li>
          </ol>
        </motion.div>
      </motion.div>

      {/* The snake: above everything, outside the lifting page */}
      {flying && !reduce && (
        <svg
          ref={svgRef}
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-[95] h-full w-full"
          style={{ filter: 'drop-shadow(0 8px 16px rgba(0,0,0,0.3))', opacity: 0 }}
        >
          {/* Tail first, so the head is drawn on top */}
          {Array.from({ length: SEGMENTS }, (_, i) => SEGMENTS - 1 - i).map((i) => (
            <line
              key={i}
              ref={(el) => {
                segRefs.current[i] = el;
              }}
              strokeLinecap="round"
              stroke="white"
            />
          ))}
          <polyline ref={stripeRef} fill="none" stroke="#111827" strokeLinecap="round" strokeLinejoin="round" opacity={0} />
        </svg>
      )}
    </>
  );
}
