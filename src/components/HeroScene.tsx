import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react';
import { ArrowRight, ChevronDown } from 'lucide-react';
import { RouteBar } from './RouteBar.tsx';

type RouteBarProps = ComponentProps<typeof RouteBar>;

interface HeroSceneProps extends Omit<RouteBarProps, 'variant' | 'hoveredStopId' | 'onHoverStop'> {
  /** Leave the landing page for the map and ticket view. */
  onEnter: () => void;
}

/**
 * The landing hero: a 5 second camera move (/public/hero/hero.mp4) that starts on the hiker's back
 * and pulls up and away to reveal the mountain. The clip is played once and holds its last frame;
 * then the slogan pops in, soft fog keeps drifting over the held frame, and the page scrolls itself
 * down to the route bar.
 */
const EASE = [0.22, 1, 0.36, 1] as const;
const FONT = "'Plus Jakarta Sans', 'DM Sans', system-ui, sans-serif";

interface FogProps {
  id: string;
  /** Top and height as a percentage of the hero. */
  top: number;
  height: number;
  seed: number;
  /** Noise scale: smaller x = longer streaks. */
  freq: string;
  /** Cloud density: alpha = gain * noise + bias. */
  gain: number;
  bias: number;
  opacity: number;
  /** Sideways drift in percent of the layer's width, and a full back-and-forth in seconds. */
  drift: number;
  duration: number;
  reduce: boolean | null;
}

/**
 * A drifting bank of cloud: procedural fractal noise turned into soft white, faded at the top and
 * bottom. The noise is rendered once and then only moved, so the wind costs almost nothing.
 */
function Fog({ id, top, height, seed, freq, gain, bias, opacity, drift, duration, reduce }: FogProps) {
  return (
    <div className="absolute" style={{ left: '-20%', width: '140%', top: `${top}%`, height: `${height}%`, opacity }}>
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
        <svg viewBox="0 0 1531 300" preserveAspectRatio="none" className="h-full w-full" aria-hidden="true">
          <filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency={freq} numOctaves="4" seed={seed} />
            <feColorMatrix
              type="matrix"
              values={`0 0 0 0 0.96  0 0 0 0 0.97  0 0 0 0 0.98  ${gain} 0 0 0 ${bias}`}
            />
          </filter>
          <rect width="1531" height="300" filter={`url(#${id})`} />
        </svg>
      </motion.div>
    </div>
  );
}

export function HeroScene({ onEnter, ...routeBar }: HeroSceneProps) {
  const reduce = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  /** The clip has finished (or cannot play): show the slogan and the drifting fog. */
  const [played, setPlayed] = useState(false);

  // Scrolling down pushes in slightly and moves the type
  const { scrollYProgress } = useScroll({ container: scrollRef });
  const zoom = useTransform(scrollYProgress, [0, 1], [1, 1.05]);
  const yText = useTransform(scrollYProgress, [0, 1], [0, -40]);
  // The route bar waits below the fold and rises into view as the page scrolls
  const barY = useTransform(scrollYProgress, [0, 1], ['34vh', '0vh']);
  const barOpacity = useTransform(scrollYProgress, (v) => Math.min(1, v / 0.55));
  const barPointer = useTransform(scrollYProgress, (v) => (v > 0.4 ? 'auto' : 'none'));
  const cueOpacity = useTransform(scrollYProgress, [0, 0.25], [1, 0]);

  // Play the clip once. If the browser blocks autoplay or the user prefers reduced motion, jump to
  // the final frame so the scene still reads.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const finish = () => setPlayed(true);
    const toLastFrame = () => {
      const end = Number.isFinite(v.duration) ? v.duration : 5;
      v.currentTime = Math.max(0, end - 0.05);
      finish();
    };
    v.addEventListener('ended', finish);
    // A stalled or failed clip must not leave the page without a slogan
    const fallback = window.setTimeout(finish, 9000);
    if (reduce) {
      if (v.readyState >= 1) toLastFrame();
      else v.addEventListener('loadedmetadata', toLastFrame, { once: true });
    } else {
      v.play().catch(toLastFrame);
    }
    return () => {
      window.clearTimeout(fallback);
      v.removeEventListener('ended', finish);
    };
  }, [reduce]);

  // After the slogan has landed the page scrolls itself down to the route bar. Any wheel, touch or
  // key press from the visitor takes over immediately.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    let stopped = false;
    let timer = 0;
    const stop = () => {
      stopped = true;
      window.clearTimeout(timer);
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
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    events.forEach((n) => el.addEventListener(n, stop, { passive: true }));
    if (played) timer = window.setTimeout(start, reduce ? 300 : 3200);
    return () => {
      stop();
      events.forEach((n) => el.removeEventListener(n, stop));
    };
  }, [played, reduce]);

  const pop = (delay: number, duration = 1) => (reduce ? { duration: 0 } : { delay, duration, ease: EASE });

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
        <div className="sticky top-0 h-screen w-full overflow-hidden bg-[#2B2D2F]">
          {/* The camera move, held on its last frame */}
          <motion.div className="absolute inset-0" style={{ scale: zoom, transformOrigin: '50% 80%' }}>
            <video
              ref={videoRef}
              src="/hero/hero.mp4"
              muted
              playsInline
              preload="auto"
              aria-hidden="true"
              className="absolute inset-0 h-full w-full object-cover"
              style={{ objectPosition: '70% 55%' }}
            />
            {/* Wind over the held frame: soft banks drifting across the valley */}
            {played && (
              <motion.div
                className="pointer-events-none absolute inset-0"
                initial={reduce ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 2 }}
              >
                <Fog id="heroFogA" top={38} height={30} seed={5} freq="0.003 0.012" gain={2.6} bias={-0.95} opacity={0.5} drift={8} duration={20} reduce={reduce} />
                <Fog id="heroFogB" top={58} height={30} seed={17} freq="0.0035 0.014" gain={2.4} bias={-0.9} opacity={0.4} drift={6} duration={15} reduce={reduce} />
              </motion.div>
            )}
          </motion.div>

          {/* Soft vignette so the edges and the type read */}
          <div
            className="pointer-events-none absolute inset-0 z-[5]"
            style={{ background: 'radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(15,23,42,0.3) 100%)' }}
          />

          {/* Slogan: pops in once the clip has finished */}
          {played && (
            <motion.div
              className="pointer-events-none absolute left-[6vw] top-[17vh] z-10 sm:top-[20vh]"
              style={{ y: yText, fontFamily: FONT }}
            >
              <motion.p
                className="font-extrabold uppercase text-[#111827]"
                style={{ fontSize: 'clamp(0.9rem, 2.1vw, 1.9rem)', letterSpacing: '0.24em', lineHeight: 1.3 }}
                initial={reduce ? false : { opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={pop(0.1, 0.9)}
              >
                Go beyond
                <br />
                <span style={{ fontSize: '0.78em' }}>the</span>
              </motion.p>
              <motion.h1
                className="font-extrabold uppercase text-[#E8742A]"
                style={{
                  fontSize: 'clamp(3.4rem, 14vw, 13rem)',
                  letterSpacing: '0.02em',
                  lineHeight: 0.95,
                  textShadow: '0 2px 30px rgba(255,255,255,0.35)',
                }}
                initial={reduce ? false : { opacity: 0, scale: 0.86, filter: 'blur(10px)' }}
                animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                transition={pop(0.5, 1.3)}
              >
                Horizon
              </motion.h1>
            </motion.div>
          )}

          {/* Brand and skip */}
          <div className="absolute left-5 right-5 top-5 z-[40] flex items-center justify-between sm:left-8 sm:right-8 sm:top-6">
            <span className="text-sm font-extrabold uppercase tracking-[0.28em] text-white" style={{ fontFamily: FONT, textShadow: '0 1px 8px rgba(0,0,0,0.45)' }}>
              Astris Travel
            </span>
            <button
              type="button"
              onClick={onEnter}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-neutral-900/10 bg-white/75 px-3.5 py-1.5 text-xs font-semibold text-[#111827] backdrop-blur hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E]"
            >
              Open planner
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>

          {/* Scroll cue: shown until the page has scrolled to the bar */}
          {played && (
            <motion.div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-[5vh] z-30 flex flex-col items-center gap-1 text-[11px] font-bold uppercase tracking-[0.3em] text-white/90"
              style={{ opacity: cueOpacity }}
            >
              Plan your route
              <motion.span animate={reduce ? undefined : { y: [0, 6, 0] }} transition={{ duration: 1.4, repeat: Infinity }}>
                <ChevronDown className="h-5 w-5" />
              </motion.span>
            </motion.div>
          )}

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
