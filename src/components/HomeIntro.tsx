import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Plus } from 'lucide-react';
import type { TripStop } from '../../shared/types.ts';

/**
 * The home page: the route bar alone on a dark backdrop. The first keystroke sets it off: the bar
 * turns into a plane (it shrinks into a fuselage, one end sharpens into a nose, the other tapers into
 * a tail, and wings and tail fins grow out), takes off, flies a loop, then swoops in and flies along
 * the planner's route bar, uncovering it as it passes, while the home page lifts away. Typing carries
 * straight on in "Add a stop…".
 *
 * The flight is one requestAnimationFrame loop writing SVG attributes (no React renders per frame).
 * The plane follows one path, measured by arc length: a Catmull-Rom curve through a few waypoints
 * (with the loop), ending in a straight line along the route bar. Reduced motion skips the flight and
 * simply fades the page away.
 */

interface HomeIntroProps {
  /** Shown as pills before the input, exactly like the planner's route bar. */
  stops: TripStop[];
  /** The first character was typed: show the map (on phones) so the route bar can be measured. */
  onStart: () => void;
  /** The plane is about to pass over the route bar: make it visible (it is uncovered by a clip). */
  onReveal: () => void;
  /** Finished: unmount the home page and hand over what was typed. */
  onDone: (text: string) => void;
}

const MORPH_MS = 950;
const FLY_MS = 3000;
const LIFT_DELAY_S = 0.6;
const TRAIL_POINTS = 36;

type Pt = { x: number; y: number };

interface Path {
  length: number;
  at: (s: number) => { x: number; y: number; angle: number };
}

/**
 * One point of a centripetal Catmull-Rom segment between p1 and p2. Centripetal spacing never makes
 * cusps or little loops where waypoints are uneven, so the curve stays smooth everywhere.
 */
function centripetal(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const knot = (a: Pt, b: Pt) => Math.max(1e-3, Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)));
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const mix = (a: Pt, b: Pt, ta: number, tb: number): Pt => {
    const k = (u - ta) / (tb - ta);
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  };
  const a1 = mix(p0, p1, t0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, t0, t2);
  const b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

/** Samples a straight first segment + a smooth curve through the waypoints + a straight last segment. */
function buildPath(points: Pt[]): Path {
  const samples: Pt[] = [points[0], points[1]];
  for (let i = 1; i < points.length - 2; i++) {
    const steps = 64;
    for (let k = 1; k <= steps; k++) {
      samples.push(centripetal(points[i - 1], points[i], points[i + 1], points[i + 2], k / steps));
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

/** Arc length of the sample nearest to `p`. */
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
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (t: number) => t * t * (3 - 2 * t);
/** Shortest signed difference between two angles. */
const angleDiff = (a: number, b: number) => {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};
/** Take-off throttle: 0 → 1 over RAMP_MS on a cosine curve, so speed builds with no jolt. */
const RAMP_MS = 650;
const ramp = (ms: number) => (1 - Math.cos(Math.PI * clamp01(ms / RAMP_MS))) / 2;
/** Overshoots a little, so the wings "pop" out. */
const easeOutBack = (t: number) => {
  const c = 1.6;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};

/**
 * The plane seen from above, nose towards +x, centred on the origin. `morph` 0 is the bar itself
 * (a rounded bar `barW` × `barH`), 1 is the finished plane of length `len`.
 */
function planeShape(morph: number, barW: number, barH: number, len: number) {
  const body = easeInOut(clamp01(morph / 0.75));
  const ends = smooth(clamp01((morph - 0.2) / 0.6));
  const wing = Math.max(0, easeOutBack(clamp01((morph - 0.35) / 0.65)));
  const fins = Math.max(0, easeOutBack(clamp01((morph - 0.5) / 0.5)));

  const a = lerp(barW / 2, len * 0.42, body); // half-length to where the nose curve starts (+ b)
  const b = lerp(barH / 2, len * 0.06, body); // half-width of the fuselage
  const reach = 1.33 * b * lerp(1, 2.1, ends); // how far the nose bulges past the straight part
  const pinch = lerp(1, 0.2, ends); // a narrower, pointier nose
  const tail = lerp(1, 0.28, ends); // the tail end tapers to this fraction of the width
  const tailX = -a - len * 0.1 * ends; // and stretches back a little
  const f = (n: number) => n.toFixed(1);

  const noseStart = a - b;
  const fuselage =
    `M ${f(tailX)} ${f(-b * tail)} L ${f(noseStart)} ${f(-b)} ` +
    `C ${f(noseStart + reach)} ${f(-b * pinch)} ${f(noseStart + reach)} ${f(b * pinch)} ${f(noseStart)} ${f(b)} ` +
    `L ${f(tailX)} ${f(b * tail)} ` +
    `C ${f(tailX - 1.33 * b * tail)} ${f(b * tail)} ${f(tailX - 1.33 * b * tail)} ${f(-b * tail)} ${f(tailX)} ${f(-b * tail)} Z`;

  // Swept wings and tail fins, mirrored either side of the fuselage
  const sweptPair = (rootX: number, chord: number, span: number, sweep: number, tipChord: number, grow: number) => {
    const root = b * 0.7;
    const tipY = root + span * grow;
    const lead = rootX + chord / 2;
    const tipLead = lead - sweep * grow;
    const side = (sgn: number) =>
      `M ${f(lead)} ${f(sgn * root)} L ${f(tipLead)} ${f(sgn * tipY)} L ${f(tipLead - tipChord)} ${f(sgn * tipY)} L ${f(rootX - chord / 2)} ${f(sgn * root)} Z`;
    return `${side(1)} ${side(-1)}`;
  };
  const wings = sweptPair(len * 0.04, len * 0.24, len * 0.5, len * 0.2, len * 0.09, wing);
  const tailFins = sweptPair(tailX + len * 0.09, len * 0.12, len * 0.17, len * 0.07, len * 0.05, fins);
  return { fuselage, wings, tailFins };
}

function targetRect(): DOMRect {
  const el = document.querySelector<HTMLElement>('[data-route-bar="map"]');
  const r = el?.getBoundingClientRect();
  if (r && r.width > 0 && r.height > 0) return r;
  // No map on screen: fly across the top of the page instead
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
  const svgRef = useRef<SVGSVGElement>(null);
  const planeRef = useRef<SVGGElement>(null);
  const fuselageRef = useRef<SVGPathElement>(null);
  const wingsRef = useRef<SVGPathElement>(null);
  const finsRef = useRef<SVGPathElement>(null);
  const trailRef = useRef<SVGPolylineElement>(null);
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

    if (reduce) {
      callbacks.current.onReveal();
      const t = window.setTimeout(() => callbacks.current.onDone(valueRef.current), 450);
      return () => window.clearTimeout(t);
    }

    // The route bar is uncovered with a clip-path that follows the plane
    let clipped: HTMLElement | null = null;
    const clearClip = () => {
      if (clipped) clipped.style.clipPath = '';
      clipped = null;
    };

    // Wait two frames so the map (shown by onStart on phones) has laid out before measuring
    raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        const bar = barRef.current?.getBoundingClientRect();
        if (!bar) return callbacks.current.onDone(valueRef.current);
        const tgt = targetRect();
        const W = window.innerWidth;
        const H = window.innerHeight;
        const m = Math.min(W, H);
        const len = Math.max(58, Math.min(104, 0.075 * W)); // the finished plane's length
        const cx = bar.left + bar.width / 2;
        const cy = bar.top + bar.height / 2;
        const ty = tgt.top + tgt.height / 2;

        // One loop only. The plane flies right, then goes round a single big clockwise loop (down,
        // back across the screen to the left, and up), drifting up and left as it goes so that it
        // comes out level with the route bar, just before its left end, heading right. It then flies
        // straight along the bar and off the right edge. The loop's drift eases in and out, so it
        // leaves and arrives dead level and the heading never kinks.
        const r = Math.max(64, Math.min(170, 0.19 * m));
        // When the bar starts near the left edge (phones) there is no room to line up before it, so
        // the loop comes out near the screen's left edge and flies on to the bar's start
        const tight = tgt.left < 0.15 * W;
        const loopX = Math.min(W - r - 24, cx + Math.max(r * 0.9, 0.12 * W)); // where the loop begins
        const leftX = tight ? 0.06 * W : Math.max(0.05 * W, tgt.left - Math.max(60, 0.1 * W)); // where it ends
        const drift = Math.max(0, loopX - leftX); // how far left the loop carries the plane
        const rise = Math.max(0, cy - ty); // and how far up
        const loopAt = (theta: number): Pt => {
          const k = theta / (2 * Math.PI);
          const ease = k * k * (3 - 2 * k); // zero slope at both ends
          return {
            x: loopX + r * Math.sin(theta) - drift * ease,
            y: cy + r - r * Math.cos(theta) - rise * ease,
          };
        };
        const loopPoints: Pt[] = [];
        for (let i = 0; i <= 16; i++) loopPoints.push(loopAt((i / 16) * 2 * Math.PI));
        const loopIn = loopPoints[0];
        const loopBottom = loopPoints[8];
        const loopOut = loopPoints[16];
        const lineIn = tight ? { x: tgt.left + 0.22 * W, y: ty } : { x: Math.max(loopOut.x + 20, tgt.left - 30), y: ty };
        const points: Pt[] = [
          { x: cx - 40, y: cy },
          { x: cx, y: cy },
          { x: (cx + loopX) / 2, y: cy },
          ...loopPoints,
          lineIn,
          { x: tgt.right + 0.1 * W, y: ty },
          { x: W + len * 2 + 0.1 * W, y: ty },
        ];
        const path = buildPath(points);
        const sLoopIn = arcLengthNear(path, loopIn);
        const sLoopOut = Math.max(sLoopIn + 1, arcLengthNear(path, loopOut));
        const sSwing = arcLengthNear(path, loopBottom);
        const sLineIn = Math.max(sSwing + 1, arcLengthNear(path, lineIn));
        const t0 = performance.now();
        const trail: Pt[] = [];
        let heading = 0;
        let prevTime = t0;
        let bank = 0;
        let revealed = false;
        let shapeDone = false;
        // Distance flown (the path starts 40px behind the bar's centre, a lead-in that keeps the
        // take-off straight) and the current speed factor
        let s = 40;
        let pace = 1;
        // Cruise speed in px/ms: the whole tour takes about FLY_MS, but never faster than 1.25 px/ms
        const cruiseSpeed = Math.min(1.25, (path.length - 40) / FLY_MS);
        const takeOff = MORPH_MS * 0.8; // takes off just before the morph ends

        const frame = (now: number) => {
          const t = now - t0;
          const morph = clamp01(t / MORPH_MS);
          const dt = Math.min(48, now - prevTime);
          prevTime = now;
          const airborne = t > takeOff;

          // Shape: from the bar to the plane, then fixed
          if (!shapeDone) {
            const shape = planeShape(morph, bar.width, bar.height, len);
            fuselageRef.current?.setAttribute('d', shape.fuselage);
            wingsRef.current?.setAttribute('d', shape.wings);
            finsRef.current?.setAttribute('d', shape.tailFins);
            if (svgRef.current) svgRef.current.style.opacity = String(clamp01(t / 120));
            shapeDone = morph >= 1;
          }

          // Speed: builds on a gentle curve after take-off, then eases off in tight turns and picks up
          // again on the straights. The pace itself changes gradually, so the motion never jerks.
          const span = Math.max(40, len * 0.6);
          const fore = path.at(s + span);
          const aft = path.at(s - span);
          const here = path.at(s);
          const bend = Math.abs(
            angleDiff(Math.atan2(fore.y - here.y, fore.x - here.x), Math.atan2(here.y - aft.y, here.x - aft.x))
          ) / span; // radians per px
          pace += (1 / (1 + 55 * bend) - pace) * (1 - Math.exp(-dt / 180));
          if (airborne) s += cruiseSpeed * ramp(t - takeOff) * pace * dt;
          const pt = path.at(s);
          // Follow the route bar's live position on the way in (the planner may still be settling)
          const live = targetRect();
          const settle = smooth(clamp01((s - sSwing) / (sLineIn - sSwing)));
          const x = pt.x + (live.left - tgt.left) * settle;
          const y = pt.y + (live.top + live.height / 2 - ty) * settle;

          // Heading: the direction across a short stretch of path around the plane (not the local
          // sample segment, which steps at every sample), eased so the nose turns without any snap
          const targetAngle = Math.atan2(fore.y - aft.y, fore.x - aft.x);
          heading = airborne ? heading + angleDiff(targetAngle, heading) * (1 - Math.exp(-dt / 70)) : 0;
          // Bank by how sharply the path curves here (the wings look shorter), eased more slowly
          bank += (Math.min(1, bend * 70) - bank) * (1 - Math.exp(-dt / 160));
          // Swell through the loop as if it comes closer
          const inLoop = s > sLoopIn && s < sLoopOut ? Math.sin((Math.PI * (s - sLoopIn)) / (sLoopOut - sLoopIn)) : 0;
          const scale = 1 + 0.25 * inLoop * inLoop;
          const deg = (heading * 180) / Math.PI;
          planeRef.current?.setAttribute(
            'transform',
            `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${deg.toFixed(2)}) scale(${scale.toFixed(3)} ${(scale * (1 - 0.4 * Math.abs(bank))).toFixed(3)})`
          );

          // Contrail once airborne
          if (airborne) {
            trail.push({ x, y });
            if (trail.length > TRAIL_POINTS) trail.shift();
            trailRef.current?.setAttribute('points', trail.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
          }

          // Uncover the route bar behind the plane as it flies along it
          const el = document.querySelector<HTMLElement>('[data-route-bar="map"]');
          if (el) {
            if (!revealed && s >= sLineIn - len) {
              revealed = true;
              clipped = el;
              el.style.clipPath = 'inset(-40px 100% -40px -40px)';
              callbacks.current.onReveal();
            }
            if (revealed && clipped) {
              const rb = clipped.getBoundingClientRect();
              const edge = x - len * 0.15; // just behind the wings
              const right = rb.right - edge;
              clipped.style.clipPath = right <= 0 ? '' : `inset(-40px ${Math.min(rb.width + 40, right).toFixed(1)}px -40px -40px)`;
            }
          }

          if (s < path.length) raf = requestAnimationFrame(frame);
          else {
            clearClip();
            callbacks.current.onDone(valueRef.current);
          }
        };
        raf = requestAnimationFrame(frame);
      });
    });
    return () => {
      cancelAnimationFrame(raf);
      clearClip();
    };
  }, [stage, reduce]);

  const flying = stage === 'flying';

  return (
    <>
      {/* The page itself: lifts away once the plane takes off */}
      <motion.div
        role="region"
        aria-label="Astris Travel home"
        className="fixed inset-0 z-[80] flex items-center justify-center overflow-hidden bg-[#0B1220] px-4"
        initial={false}
        animate={
          flying
            ? reduce
              ? { opacity: 0, transition: { duration: 0.4 } }
              : { y: '-100%', borderBottomLeftRadius: 48, borderBottomRightRadius: 48, transition: { delay: LIFT_DELAY_S, duration: 1.2, ease: [0.7, 0, 0.2, 1] } }
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
          className="relative flex w-[min(94vw,920px)] items-center gap-1 rounded-2xl glass-strong p-1.5 pl-2"
          initial={reduce ? false : { opacity: 0, y: 16, scale: 0.96 }}
          animate={{ opacity: flying && !reduce ? 0 : 1, y: 0, scale: 1 }}
          transition={flying ? { duration: 0.12 } : { duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* Same look as the planner's route bar (RouteBar.tsx) */}
          <ol aria-label="Stops in order" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-1.5 py-0.5">
            {stops.map((stop, i) => (
              <li key={stop.id} className="flex h-8 shrink-0 items-center gap-1.5 rounded-full glass-control bg-white/90 pl-1.5 pr-2 text-xs">
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

      {/* The plane: above everything, outside the lifting page */}
      {flying && !reduce && (
        <svg
          ref={svgRef}
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-[95] h-full w-full"
          style={{ opacity: 0 }}
        >
          <polyline
            ref={trailRef}
            fill="none"
            stroke="white"
            strokeOpacity={0.35}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <g ref={planeRef} style={{ filter: 'drop-shadow(0 10px 14px rgba(0,0,0,0.3))' }}>
            <path ref={finsRef} fill="#F3F4F6" />
            <path ref={wingsRef} fill="#F9FAFB" />
            <path ref={fuselageRef} fill="white" />
          </g>
        </svg>
      )}
    </>
  );
}
