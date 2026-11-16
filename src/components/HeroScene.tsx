import { useEffect, useRef, type ComponentProps } from 'react';
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import { RouteBar } from './RouteBar.tsx';
import { WaterBackground } from './WaterBackground.tsx';

type RouteBarProps = ComponentProps<typeof RouteBar>;

type HeroSceneProps = Omit<RouteBarProps, 'variant' | 'hoveredStopId' | 'onHoverStop'>;

/**
 * The landing hero: an animated underwater-fluid backdrop (it only moves, it does not react to the
 * pointer), the slogan, and the live route bar. The slogan pops in, then the page scrolls itself down
 * to bring the "Add a stop…" bar into view.
 */
const EASE = [0.22, 1, 0.36, 1] as const;
const FONT = "'Plus Jakarta Sans', 'DM Sans', system-ui, sans-serif";

export function HeroScene(routeBar: HeroSceneProps) {
  const reduce = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scrolling down moves the slogan a little faster than the water
  const { scrollYProgress } = useScroll({ container: scrollRef });
  const yText = useTransform(scrollYProgress, [0, 1], [0, -60]);
  // The route bar waits below the fold and rises into view as the page scrolls
  const barY = useTransform(scrollYProgress, [0, 1], ['34vh', '0vh']);
  const barOpacity = useTransform(scrollYProgress, (v) => Math.min(1, v / 0.55));
  const barPointer = useTransform(scrollYProgress, (v) => (v > 0.4 ? 'auto' : 'none'));
  const cueOpacity = useTransform(scrollYProgress, [0, 0.25], [1, 0]);

  // After the slogan has landed the page scrolls itself down to the route bar. Any wheel, touch or
  // key press from the visitor takes over immediately.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    let stopped = false;
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
    const timer = window.setTimeout(start, reduce ? 300 : 4200);
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    events.forEach((n) => el.addEventListener(n, stop, { passive: true }));
    return () => {
      stop();
      events.forEach((n) => el.removeEventListener(n, stop));
    };
  }, [reduce]);

  const pop = (delay: number, duration = 1.2) => (reduce ? { duration: 0 } : { delay, duration, ease: EASE });

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
        <div className="sticky top-0 h-screen w-full overflow-hidden bg-[#050505]">
          <motion.div
            className="absolute inset-0"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={reduce ? { duration: 0 } : { duration: 1.6 }}
          >
            <WaterBackground />
          </motion.div>

          {/* Slogan */}
          <motion.div
            className="pointer-events-none absolute inset-x-0 top-[26vh] z-10 px-[6vw] text-center"
            style={{ y: yText, fontFamily: FONT }}
          >
            <motion.h1
              className="font-extrabold uppercase text-[#F6F1EA]"
              style={{
                fontSize: 'clamp(2.4rem, 8.6vw, 8.5rem)',
                lineHeight: 0.98,
                letterSpacing: '0.01em',
                textShadow: '0 2px 40px rgba(0,0,0,0.35)',
              }}
              initial={reduce ? false : { opacity: 0, scale: 0.92, filter: 'blur(14px)' }}
              animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
              transition={pop(1.0, 1.6)}
            >
              Go beyond
              <br />
              the horizon
            </motion.h1>
          </motion.div>

          {/* Scroll cue: an arrow only, shown until the page has scrolled to the bar */}
          <motion.div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-[5vh] z-30 flex justify-center text-white/80"
            style={{ opacity: cueOpacity }}
          >
            <motion.span animate={reduce ? undefined : { y: [0, 6, 0] }} transition={{ duration: 1.4, repeat: Infinity }}>
              <ChevronDown className="h-6 w-6" />
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
