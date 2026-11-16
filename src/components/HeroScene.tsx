import { useEffect, useRef, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react';
import { ArrowRight, ChevronDown } from 'lucide-react';
import { RouteBar } from './RouteBar.tsx';

type RouteBarProps = ComponentProps<typeof RouteBar>;

interface HeroSceneProps extends Omit<RouteBarProps, 'variant' | 'hoveredStopId' | 'onHoverStop'> {
  /** Leave the landing page for the map and ticket view. */
  onEnter: () => void;
}

/**
 * The scene is built from two photographs in /public/hero (same width, so they line up):
 *   bg.webp     1094 x 746  sky, mountain, forest (the hiker and rock removed)
 *   hiker.webp  1094 x 403  the hiker and his rock, transparent around them; sits on the bottom edge
 * Everything else (cloud banks, wisps, type) is drawn in the same 1094 x 746 coordinate space, so it
 * stays registered with the photos at any window size.
 */
const W = 1094;
const H = 746;
const HIKER_H = 403;
/** Where the hiker stands in the scene, in photo pixels. */
const HIKER_X = 555;
const GAP_HALF = 52; // half the gap the type leaves for him

/** A box as wide as the window and cropped like `object-fit: cover`, anchored to the bottom. */
const stageStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: '-10vh', // a little spare below the photo so the scroll parallax never shows an edge
  width: `max(100vw, calc(110vh * ${W / H}))`,
  aspectRatio: `${W} / ${H}`,
  transform: 'translateX(-50%)',
};

const DOLLY_EASE = [0.22, 1, 0.36, 1] as const;

/**
 * One depth layer of the dolly zoom-out: each layer starts enlarged by a different amount and settles
 * to 1, so the background swells away faster than the foreground, like a lens pulling back.
 */
function Dolly({ from, z, reduce, children }: { from: number; z: string; reduce: boolean | null; children: ReactNode }) {
  return (
    <motion.div
      className={`absolute inset-0 ${z}`}
      style={{ transformOrigin: '50% 90%' }}
      initial={reduce ? false : { scale: from }}
      animate={{ scale: 1 }}
      transition={reduce ? { duration: 0 } : { duration: 4.2, ease: DOLLY_EASE }}
    >
      {children}
    </motion.div>
  );
}

interface FogProps {
  id: string;
  /** Top and height in photo pixels. */
  y: number;
  h: number;
  seed: number;
  /** Noise scale: smaller x = longer streaks. */
  freq: string;
  /** Cloud density: alpha = gain * noise + bias. */
  gain: number;
  bias: number;
  opacity: number;
  /** Opacity to settle to after the intro, if the bank should thin out. */
  thinTo?: number;
  /** Sideways drift in percent of the layer's width, and a full back-and-forth in seconds. */
  drift: number;
  duration: number;
  reduce: boolean | null;
}

/**
 * A drifting bank of cloud: procedural fractal noise turned into soft white, faded at the top and
 * bottom. The noise is rendered once and then only moved, so the wind costs almost nothing.
 */
function Fog({ id, y, h, seed, freq, gain, bias, opacity, thinTo, drift, duration, reduce }: FogProps) {
  const w = W * 1.4;
  return (
    <motion.div
      className="absolute"
      style={{ left: '-20%', width: '140%', top: `${(y / H) * 100}%`, height: `${(h / H) * 100}%` }}
      initial={reduce ? false : { opacity }}
      animate={{ opacity: thinTo ?? opacity }}
      transition={reduce ? { duration: 0 } : { delay: 0.8, duration: 4.5, ease: DOLLY_EASE }}
    >
      <motion.div
        className="h-full w-full"
        style={{
          willChange: 'transform',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent, #000 32%, #000 68%, transparent)',
          maskImage: 'linear-gradient(to bottom, transparent, #000 32%, #000 68%, transparent)',
        }}
        animate={reduce ? undefined : { x: [`${-drift}%`, `${drift}%`] }}
        transition={{ duration, ease: 'easeInOut', repeat: Infinity, repeatType: 'mirror' }}
      >
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-full w-full" aria-hidden="true">
          <filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency={freq} numOctaves="4" seed={seed} />
            <feColorMatrix
              type="matrix"
              values={`0 0 0 0 0.96  0 0 0 0 0.97  0 0 0 0 0.98  ${gain} 0 0 0 ${bias}`}
            />
          </filter>
          <rect width={w} height={h} filter={`url(#${id})`} />
        </svg>
      </motion.div>
    </motion.div>
  );
}

// The hiker's torso (jacket, pack, beanie) is the part that breathes. These are fractions of the
// foreground image; the rest of the picture is cut around that box so nothing doubles up.
const TORSO = { left: 46, right: 55.5, bottom: 26.8 };

const hikerImg: CSSProperties = { position: 'absolute', left: 0, bottom: 0, width: '100%', height: 'auto' };

function HikerPhoto({ reduce }: { reduce: boolean | null }) {
  const src = '/hero/hiker.webp';
  const notch = `polygon(0 0, ${TORSO.left}% 0, ${TORSO.left}% ${TORSO.bottom}%, ${TORSO.right}% ${TORSO.bottom}%, ${TORSO.right}% 0, 100% 0, 100% 100%, 0 100%)`;
  const torso = `inset(0 ${100 - TORSO.right}% ${100 - TORSO.bottom - 0.6}% ${TORSO.left}%)`;
  const box: CSSProperties = { position: 'absolute', left: 0, bottom: 0, width: '100%', aspectRatio: `${W} / ${HIKER_H}` };
  return (
    <div style={box}>
      {/* Rock, bush and legs */}
      <img src={src} alt="" draggable={false} style={{ ...hikerImg, clipPath: notch }} fetchPriority="high" />
      {/* Upper body: breathes from the hips */}
      <motion.div
        className="absolute inset-0"
        style={{ transformOrigin: `50% ${TORSO.bottom}%` }}
        animate={reduce ? undefined : { scaleY: [1, 1.03, 1], scaleX: [1, 1.006, 1] }}
        transition={{ duration: 3.6, ease: 'easeInOut', repeat: Infinity }}
      >
        <img src={src} alt="" draggable={false} style={{ ...hikerImg, clipPath: torso }} />
      </motion.div>
    </div>
  );
}

export function HeroScene({ onEnter, ...routeBar }: HeroSceneProps) {
  const reduce = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scrolling down parallaxes the layers (far ones barely move)
  const { scrollYProgress } = useScroll({ container: scrollRef });
  const yBg = useTransform(scrollYProgress, [0, 1], [0, -15]);
  const yFog = useTransform(scrollYProgress, [0, 1], [0, -30]);
  const yText = useTransform(scrollYProgress, [0, 1], [0, -45]);
  const yFront = useTransform(scrollYProgress, [0, 1], [0, -65]);
  const zoom = useTransform(scrollYProgress, [0, 1], [1, 1.03]);
  // The route bar waits below the fold and rises into view as the page scrolls
  const barY = useTransform(scrollYProgress, [0, 1], ['34vh', '0vh']);
  const barOpacity = useTransform(scrollYProgress, (v) => Math.min(1, v / 0.55));
  const barPointer = useTransform(scrollYProgress, (v) => (v > 0.4 ? 'auto' : 'none'));
  const cueOpacity = useTransform(scrollYProgress, [0, 0.25], [1, 0]);

  // Once the intro has played the page scrolls itself down to the route bar. Any wheel, touch or key
  // press from the visitor takes over immediately.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    let stopped = false;
    const stop = () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
    const start = () => {
      if (stopped) return;
      const from = el.scrollTop;
      const to = el.scrollHeight - el.clientHeight;
      const duration = reduce ? 0 : 2200;
      const t0 = performance.now();
      const step = (now: number) => {
        if (stopped) return;
        const k = duration ? Math.min(1, (now - t0) / duration) : 1;
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        el.scrollTop = from + (to - from) * e;
        if (k < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    const timer = window.setTimeout(start, reduce ? 300 : 5600);
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    events.forEach((n) => el.addEventListener(n, stop, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      stop();
      events.forEach((n) => el.removeEventListener(n, stop));
    };
  }, [reduce]);

  const show = (delay: number, duration = 1.1) =>
    reduce ? { duration: 0 } : { delay, duration, ease: DOLLY_EASE };

  const font = "'Plus Jakarta Sans', 'DM Sans', system-ui, sans-serif";

  return (
    <motion.div
      ref={scrollRef}
      role="region"
      aria-label="Astris Travel: Go beyond the horizon"
      className="fixed inset-0 z-50 overflow-y-auto overflow-x-hidden"
      style={{ scrollbarWidth: 'none' }}
      exit={{ opacity: 0, transition: { duration: 0.5 } }}
    >
      <div style={{ height: '150vh' }}>
        <div className="sticky top-0 h-screen w-full overflow-hidden bg-[#1B1D20]">
          {/* Slow push-in while scrolling down to the bar */}
          <motion.div className="absolute inset-0" style={{ scale: zoom, transformOrigin: '50% 90%' }}>
            <div style={stageStyle}>
              {/* Photo: sky, mountain and forest. It rises out of the cloud bank. */}
              <Dolly from={1.5} z="z-[5]" reduce={reduce}>
                <motion.div className="absolute inset-0" style={{ y: yBg }}>
                  <motion.img
                    src="/hero/bg.webp"
                    alt=""
                    draggable={false}
                    className="absolute inset-0 h-full w-full"
                    fetchPriority="high"
                    initial={reduce ? false : { y: '12%' }}
                    animate={{ y: 0 }}
                    transition={reduce ? { duration: 0 } : { delay: 0.4, duration: 3.8, ease: [0.3, 0.7, 0.2, 1] }}
                  />
                </motion.div>
              </Dolly>

              {/* Cloud bank that hides the peak at first, then thins and lets it rise out */}
              <Dolly from={1.4} z="z-[7]" reduce={reduce}>
                <motion.div className="absolute inset-0" style={{ y: yFog }}>
                  <Fog id="fogBank" y={90} h={430} seed={4} freq="0.0028 0.006" gain={3.4} bias={-1.1} opacity={1} thinTo={0.28} drift={5} duration={26} reduce={reduce} />
                  <Fog id="fogWisps" y={330} h={240} seed={11} freq="0.004 0.014" gain={2.6} bias={-0.95} opacity={0.55} drift={9} duration={17} reduce={reduce} />
                </motion.div>
              </Dolly>

              {/* Display type: behind the hiker, so he becomes the "I" */}
              <Dolly from={1.12} z="z-10" reduce={reduce}>
                <motion.div className="absolute inset-0" style={{ y: yText }}>
                  <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden="true">
                    <motion.g
                      initial={reduce ? false : { opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={show(2.7, 0.9)}
                      fontFamily={font}
                      fontWeight={800}
                      textAnchor="middle"
                      fill="#111827"
                    >
                      <text x={HIKER_X} y="296" fontSize="27" letterSpacing="6">GO BEYOND</text>
                      <text x={HIKER_X} y="328" fontSize="19" letterSpacing="6">THE</text>
                    </motion.g>
                    <g fontFamily={font} fontWeight={800} fill="#E8742A" fontSize="170" letterSpacing="9">
                      <motion.text
                        x={HIKER_X - GAP_HALF}
                        y="478"
                        textAnchor="end"
                        initial={reduce ? false : { opacity: 0, x: 90 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={show(3.3, 1.4)}
                      >
                        HOR
                      </motion.text>
                      <motion.text
                        x={HIKER_X + GAP_HALF}
                        y="478"
                        textAnchor="start"
                        initial={reduce ? false : { opacity: 0, x: -90 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={show(3.3, 1.4)}
                      >
                        ZON
                      </motion.text>
                    </g>
                  </svg>
                </motion.div>
              </Dolly>

              {/* Hiker and rock photo, bottom-aligned (z-20) */}
              <Dolly from={1.12} z="z-20" reduce={reduce}>
                <motion.div className="absolute inset-0" style={{ y: yFront }}>
                  <HikerPhoto reduce={reduce} />
                </motion.div>
              </Dolly>

              {/* Low fog rolling over the base of the rock */}
              <Dolly from={1.2} z="z-[22]" reduce={reduce}>
                <motion.div className="pointer-events-none absolute inset-0" style={{ y: yFront }}>
                  <Fog id="fogLow" y={520} h={226} seed={23} freq="0.0035 0.012" gain={2.4} bias={-0.9} opacity={0.5} drift={7} duration={14} reduce={reduce} />
                </motion.div>
              </Dolly>
            </div>
          </motion.div>

          {/* Soft vignette so the edges read */}
          <div
            className="pointer-events-none absolute inset-0 z-[25]"
            style={{ background: 'radial-gradient(ellipse at 50% 45%, transparent 60%, rgba(15,23,42,0.3) 100%)' }}
          />

          {/* Brand and skip */}
          <div className="absolute left-5 right-5 top-5 z-[40] flex items-center justify-between sm:left-8 sm:right-8 sm:top-6">
            <span className="text-sm font-extrabold uppercase tracking-[0.28em] text-[#111827]" style={{ fontFamily: font }}>
              Astris Travel
            </span>
            <button
              type="button"
              onClick={onEnter}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-neutral-900/10 bg-white/70 px-3.5 py-1.5 text-xs font-semibold text-[#111827] backdrop-blur hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E]"
            >
              Open planner
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>

          {/* Scroll cue: shown until the page has scrolled to the bar */}
          <motion.div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-[5vh] z-30 flex flex-col items-center gap-1 text-[11px] font-bold uppercase tracking-[0.3em] text-white/90"
            style={{ opacity: cueOpacity }}
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 4.6, duration: 0.6 }}
          >
            Plan your route
            <motion.span animate={reduce ? undefined : { y: [0, 6, 0] }} transition={{ duration: 1.4, repeat: Infinity }}>
              <ChevronDown className="h-5 w-5" />
            </motion.span>
          </motion.div>

          {/* Interactive route bar (z-30), wired to the live trip: rises in as the page scrolls */}
          <motion.div
            className="absolute inset-x-0 bottom-[7vh] z-30"
            style={{ y: barY, opacity: barOpacity, pointerEvents: barPointer }}
          >
            <div className="mx-auto w-[min(94vw,920px)]">
              <RouteBar {...routeBar} variant="hero" hoveredStopId={null} onHoverStop={() => {}} />
            </div>
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}
