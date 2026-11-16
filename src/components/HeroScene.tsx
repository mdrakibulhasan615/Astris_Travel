import { useEffect, useMemo, useRef, type ComponentProps, type ReactNode } from 'react';
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react';
import { ArrowRight, ChevronDown } from 'lucide-react';
import { RouteBar } from './RouteBar.tsx';

type RouteBarProps = ComponentProps<typeof RouteBar>;

interface HeroSceneProps extends Omit<RouteBarProps, 'variant' | 'hoveredStopId' | 'onHoverStop'> {
  /** Leave the landing page for the map and ticket view. */
  onEnter: () => void;
}

// ── Deterministic vector scenery (no raster images: sharp at any size) ────────────────────────────

type Pt = [number, number];

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A craggy ridge line through alternating valley / peak / valley key points. Returns the closed
 * silhouette, the open ridge line (for snow-edge highlights) and light / shadow facets per peak.
 */
function buildRange(keys: Pt[], baseY: number, jag: number, seed: number) {
  const r = rng(seed);
  const pts: Pt[] = [];
  for (let i = 0; i < keys.length - 1; i++) {
    const [x0, y0] = keys[i];
    const [x1, y1] = keys[i + 1];
    const n = 7;
    pts.push([x0, y0]);
    for (let j = 1; j < n; j++) {
      const t = j / n;
      pts.push([x0 + (x1 - x0) * t + (r() - 0.5) * jag * 0.8, y0 + (y1 - y0) * t + (r() - 0.5) * jag]);
    }
  }
  pts.push(keys[keys.length - 1]);
  const f = (n: number) => n.toFixed(1);
  const top = pts.map((p, i) => `${i ? 'L' : 'M'}${f(p[0])} ${f(p[1])}`).join(' ');
  const first = pts[0];
  const last = pts[pts.length - 1];
  const fill = `${top} L${f(last[0])} ${baseY} L${f(first[0])} ${baseY} Z`;

  const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const shade: string[] = [];
  const light: string[] = [];
  for (let i = 1; i < keys.length - 1; i += 2) {
    const peak = keys[i];
    const lv = keys[i - 1];
    const rv = keys[i + 1];
    const rp = lerp(peak, rv, 0.9);
    const q1: Pt = [peak[0] + (rv[0] - peak[0]) * 0.14, peak[1] + (rv[1] - peak[1]) * 0.95];
    shade.push(`M${f(peak[0])} ${f(peak[1])} L${f(rp[0])} ${f(rp[1])} L${f(q1[0])} ${f(q1[1])} Z`);
    const lp = lerp(peak, lv, 0.9);
    const q2: Pt = [peak[0] - (peak[0] - lv[0]) * 0.1, peak[1] + (lv[1] - peak[1]) * 0.8];
    light.push(`M${f(peak[0])} ${f(peak[1])} L${f(lp[0])} ${f(lp[1])} L${f(q2[0])} ${f(q2[1])} Z`);
  }
  return { top, fill, shade: shade.join(' '), light: light.join(' ') };
}

/** Three stacked triangles: a pine. */
function pinePath(x: number, baseY: number, h: number): string {
  const w = h * 0.34;
  const tiers = 3;
  let d = '';
  for (let i = 0; i < tiers; i++) {
    const top = baseY - h + (h * i * 0.28);
    const bottom = top + h * 0.5;
    const half = w * (0.45 + i * 0.28);
    d += `M${x} ${top.toFixed(1)} L${(x + half).toFixed(1)} ${bottom.toFixed(1)} L${(x - half).toFixed(1)} ${bottom.toFixed(1)} Z `;
  }
  return d + `M${x - 2} ${baseY} h4 v8 h-4 Z`;
}

const FAR_KEYS: Pt[] = [
  [-900, 560], [-620, 420], [-340, 560], [-60, 330], [250, 540], [520, 360], [760, 560],
  [1010, 300], [1260, 540], [1520, 250], [1780, 540], [2050, 340], [2300, 560], [2600, 420], [2900, 560],
];
const MAIN_KEYS: Pt[] = [
  [-700, 600], [-420, 400], [-160, 590], [140, 350], [420, 600], [640, 290], [740, 480],
  [830, 105], [960, 470], [1100, 250], [1220, 540], [1370, 200], [1560, 560], [1760, 300],
  [1960, 580], [2200, 380], [2500, 600],
];

const FAR = buildRange(FAR_KEYS, 760, 28, 7);
const MAIN = buildRange(MAIN_KEYS, 780, 34, 21);

const LEFT_PINES: [number, number, number][] = [
  [-120, 330, 120], [-30, 380, 130], [60, 420, 150], [150, 470, 150], [230, 530, 160], [300, 585, 150], [360, 640, 140],
  [-200, 300, 110], [20, 520, 150], [110, 570, 170], [200, 640, 160], [270, 700, 170],
];
const RIGHT_PINES: [number, number, number][] = [
  [1700, 640, 120], [1760, 600, 150], [1830, 560, 140], [1900, 520, 150], [1980, 480, 150],
  [1640, 720, 150], [1720, 700, 190], [1800, 690, 170], [1890, 640, 190], [1960, 600, 170],
];
const FRONT_PINES: [number, number, number][] = [
  [1270, 800, 150], [1340, 810, 210], [1420, 790, 240], [1500, 800, 200], [1580, 820, 250], [1680, 800, 220],
];

// ── The scene ────────────────────────────────────────────────────────────────────────────────────

const VIEW = '0 0 1600 900';

/** Every layer shares this box so text, hiker and rock stay aligned at any window size. */
const layerSvgProps = {
  viewBox: VIEW,
  preserveAspectRatio: 'xMidYMax meet',
  className: 'absolute inset-0 h-full w-full overflow-visible',
  'aria-hidden': true,
} as const;

const DOLLY_EASE = [0.22, 1, 0.36, 1] as const;

/**
 * One depth layer of the dolly zoom-out: each layer starts enlarged by a different amount and settles
 * to 1, so the background swells away faster than the foreground, like a lens pulling back.
 */
function Dolly({ from, z, reduce, children }: { from: number; z: string; reduce: boolean | null; children: ReactNode }) {
  return (
    <motion.div
      className={`absolute inset-0 ${z}`}
      style={{ transformOrigin: '50% 80%' }}
      initial={reduce ? false : { scale: from }}
      animate={{ scale: 1 }}
      transition={reduce ? { duration: 0 } : { duration: 4.2, ease: DOLLY_EASE }}
    >
      {children}
    </motion.div>
  );
}

/** Backdrop layers fill the window (cropping the sides) instead of letterboxing. */
const backdropSvgProps = { ...layerSvgProps, preserveAspectRatio: 'xMidYMax slice' } as const;

function Hiker({ reduce }: { reduce: boolean | null }) {
  return (
    <g>
      {/* Ground shadow */}
      <ellipse cx="800" cy="774" rx="52" ry="6" fill="#020617" opacity="0.45" />

      {/* Lower body and boots: planted on the rock */}
      <g>
        <path d="M776 630 L799 630 L797 758 L774 758 Z" fill="#1B2735" />
        <path d="M801 630 L824 630 L826 758 L803 758 Z" fill="#243447" />
        <path d="M799 636 L801 636 L801 758 L799 758 Z" fill="#0B1220" opacity="0.6" />
        <path d="M769 755 L798 755 L800 773 L765 773 Q763 763 769 755 Z" fill="#0B1220" />
        <path d="M802 755 L831 755 Q837 763 835 773 L800 773 Z" fill="#0F172A" />
        <path d="M766 770 L799 770 M801 770 L834 770" stroke="#334155" strokeWidth="1.6" strokeLinecap="round" />
      </g>

      {/* Upper body, pack and head: breathes on its own */}
      <motion.g
        style={{ originX: 0.5, originY: 1 }}
        animate={reduce ? undefined : { y: [0, -2.5, 0], scaleY: [1, 1.022, 1] }}
        transition={{ duration: 3.6, ease: 'easeInOut', repeat: Infinity }}
      >
        {/* Arms and gloves */}
        <path d="M761 541 Q746 563 749 604 L752 634 L765 636 L769 603 L771 548 Z" fill="#EA580C" />
        <path d="M839 541 Q854 563 851 604 L848 634 L835 636 L831 603 L829 548 Z" fill="#D9500A" />
        <circle cx="758" cy="643" r="7" fill="#1F2937" />
        <circle cx="842" cy="643" r="7" fill="#1F2937" />

        {/* Jacket */}
        <path d="M761 541 Q800 524 839 541 L843 600 L837 650 L763 650 L757 600 Z" fill="#EA580C" />
        <path d="M761 541 Q778 532 790 531 L784 600 L772 650 L763 650 L757 600 Z" fill="#F97316" opacity="0.55" />
        <path d="M763 640 L837 640 L837 651 L763 651 Z" fill="#C2410C" />

        {/* Backpack */}
        <path d="M771 548 Q800 539 829 548 L833 622 Q800 633 767 622 Z" fill="#475569" />
        <path d="M769 549 Q800 535 831 549 L831 568 Q800 559 769 568 Z" fill="#334155" />
        <path d="M800 560 L800 628" stroke="#2A3646" strokeWidth="2" />
        <rect x="778" y="596" width="44" height="26" rx="7" fill="#3B4A5E" />
        <path d="M783 604 L817 604" stroke="#64748B" strokeWidth="1.6" strokeLinecap="round" />
        <rect x="832" y="586" width="10" height="36" rx="5" fill="#64748B" />
        <path d="M772 552 Q767 590 770 618" stroke="#94A3B8" strokeWidth="2" fill="none" opacity="0.5" strokeLinecap="round" />
        {/* Shoulder straps and hip belt */}
        <path d="M765 543 Q755 575 764 614" stroke="#0F172A" strokeWidth="5" fill="none" strokeLinecap="round" />
        <path d="M835 543 Q845 575 836 614" stroke="#0F172A" strokeWidth="5" fill="none" strokeLinecap="round" />
        <rect x="760" y="626" width="80" height="8" rx="3" fill="#1F2937" />

        {/* Hood collar, neck, beanie */}
        <ellipse cx="800" cy="529" rx="26" ry="11" fill="#C2410C" />
        <rect x="791" y="508" width="18" height="20" rx="8" fill="#B07A56" />
        <path d="M783 500 Q782 475 800 474 Q818 475 817 500 Z" fill="#111827" />
        <rect x="782" y="496" width="36" height="9" rx="4" fill="#1F2937" />
        <path d="M786 490 Q790 479 800 478" stroke="#374151" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      </motion.g>
    </g>
  );
}

export function HeroScene({ onEnter, ...routeBar }: HeroSceneProps) {
  const reduce = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scrolling down parallaxes the layers (far ones barely move) and finally opens the planner
  const { scrollYProgress } = useScroll({ container: scrollRef });
  const yMountains = useTransform(scrollYProgress, [0, 1], [0, -30]);
  const yMistBack = useTransform(scrollYProgress, [0, 1], [0, -55]);
  const yText = useTransform(scrollYProgress, [0, 1], [0, -85]);
  const yMistFront = useTransform(scrollYProgress, [0, 1], [0, -110]);
  const yFront = useTransform(scrollYProgress, [0, 1], [0, -150]);
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

  const ease = [0.22, 1, 0.36, 1] as const;
  const show = (delay: number, duration = 1.1) =>
    reduce ? { duration: 0 } : { delay, duration, ease };

  const pines = useMemo(
    () => ({
      left: LEFT_PINES.map(([x, y, h]) => pinePath(x, y, h)).join(' '),
      right: RIGHT_PINES.map(([x, y, h]) => pinePath(x, y, h)).join(' '),
      front: FRONT_PINES.map(([x, y, h]) => pinePath(x, y, h)).join(' '),
    }),
    []
  );

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
        <div className="sticky top-0 h-screen w-full overflow-hidden">
          {/* Sky: mist at the top, depth below */}
          <div
            className="absolute inset-0"
            style={{ background: 'linear-gradient(to bottom, #E2E8F0 0%, #CBD5E1 32%, #94A3B8 68%, #1E293B 100%)' }}
          />

          {/* Slow push-in while scrolling down to the bar */}
          <div className="absolute inset-0">
            <motion.div className="absolute inset-0" style={{ scale: zoom, transformOrigin: '50% 80%' }}>
              {/* Sky clouds (z-2): big soft banks pushed along by the wind */}
              <Dolly from={1.7} z="z-[2]" reduce={reduce}>
                <svg {...backdropSvgProps}>
                  <defs>
                    <filter id="skyBlur" x="-30%" y="-80%" width="160%" height="260%">
                      <feGaussianBlur stdDeviation="46" />
                    </filter>
                  </defs>
                  <motion.g
                    animate={reduce ? undefined : { x: [-140, 140] }}
                    transition={{ duration: 40, ease: 'easeInOut', repeat: Infinity, repeatType: 'mirror' }}
                  >
                    <g filter="url(#skyBlur)">
                      <ellipse cx="200" cy="120" rx="360" ry="90" fill="#FFFFFF" opacity="0.8" />
                      <ellipse cx="720" cy="40" rx="420" ry="80" fill="#F8FAFC" opacity="0.7" />
                      <ellipse cx="1300" cy="140" rx="400" ry="100" fill="#FFFFFF" opacity="0.75" />
                      <ellipse cx="1800" cy="60" rx="380" ry="80" fill="#F1F5F9" opacity="0.7" />
                      <ellipse cx="0" cy="300" rx="340" ry="80" fill="#94A3B8" opacity="0.5" />
                      <ellipse cx="1550" cy="330" rx="380" ry="70" fill="#94A3B8" opacity="0.45" />
                    </g>
                  </motion.g>
                </svg>
              </Dolly>

              {/* Mountains (z-5): rise out of the cloud bank */}
              <Dolly from={1.55} z="z-[5]" reduce={reduce}>
              <motion.div className="absolute inset-0" style={{ y: yMountains }}>
                <motion.svg
                  {...backdropSvgProps}
                  initial={reduce ? false : { y: 440, opacity: 0.6 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={reduce ? { duration: 0 } : { delay: 0.5, duration: 3.6, ease: [0.3, 0.7, 0.2, 1] }}
                >
                  <defs>
                    <linearGradient id="farGrad" gradientUnits="userSpaceOnUse" x1="0" y1="250" x2="0" y2="700">
                      <stop offset="0" stopColor="#F1F5F9" />
                      <stop offset="0.5" stopColor="#CBD5E1" />
                      <stop offset="1" stopColor="#94A3B8" />
                    </linearGradient>
                    <linearGradient id="mainGrad" gradientUnits="userSpaceOnUse" x1="0" y1="100" x2="0" y2="700">
                      <stop offset="0" stopColor="#FFFFFF" />
                      <stop offset="0.22" stopColor="#F1F5F9" />
                      <stop offset="0.42" stopColor="#A9B6C6" />
                      <stop offset="0.7" stopColor="#64748B" />
                      <stop offset="1" stopColor="#334155" />
                    </linearGradient>
                    <clipPath id="mainClip">
                      <path d={MAIN.fill} />
                    </clipPath>
                  </defs>
                  <path d={FAR.fill} fill="url(#farGrad)" opacity="0.85" />
                  <path d={MAIN.fill} fill="url(#mainGrad)" />
                  <g clipPath="url(#mainClip)">
                    <path d={MAIN.shade} fill="#0F172A" opacity="0.32" />
                    <path d={MAIN.light} fill="#FFFFFF" opacity="0.38" />
                  </g>
                  <path d={MAIN.top} fill="none" stroke="#FFFFFF" strokeWidth="1.6" strokeLinejoin="round" opacity="0.7" />
                  {/* Dark forested slopes */}
                  <path d="M-900 120 L-420 230 L-60 330 L120 450 L300 590 L420 900 L-900 900 Z" fill="#0F172A" opacity="0.94" />
                  <path d="M2400 380 L2000 470 L1760 600 L1620 720 L1560 900 L2400 900 Z" fill="#0F172A" opacity="0.94" />
                  {/* Trees lean slightly with the wind */}
                  <motion.path
                    d={pines.left}
                    fill="#0B1220"
                    style={{ originX: 0.5, originY: 1 }}
                    animate={reduce ? undefined : { rotate: [-0.5, 0.6] }}
                    transition={{ duration: 6, ease: 'easeInOut', repeat: Infinity, repeatType: 'mirror' }}
                  />
                  <motion.path
                    d={pines.right}
                    fill="#0B1220"
                    style={{ originX: 0.5, originY: 1 }}
                    animate={reduce ? undefined : { rotate: [0.6, -0.5] }}
                    transition={{ duration: 7.5, ease: 'easeInOut', repeat: Infinity, repeatType: 'mirror' }}
                  />
                </motion.svg>
              </motion.div>
              </Dolly>

              {/* Back mist (z-8) */}
              <Dolly from={1.4} z="z-[8]" reduce={reduce}>
              <motion.div className="absolute inset-0" style={{ y: yMistBack }}>
                <motion.svg {...backdropSvgProps}>
                  <defs>
                    <filter id="mistBlur" x="-20%" y="-60%" width="140%" height="220%">
                      <feGaussianBlur stdDeviation="30" />
                    </filter>
                  </defs>
                  {/* Thick cloud bank that hides the peaks at first, then thins and sinks */}
                  <motion.g
                    initial={reduce ? false : { opacity: 1, y: -60 }}
                    animate={{ opacity: 0.55, y: 40 }}
                    transition={reduce ? { duration: 0 } : { delay: 0.8, duration: 4.5, ease: DOLLY_EASE }}
                  >
                    <motion.g
                      animate={reduce ? undefined : { x: [60, -60] }}
                      transition={{ duration: 21, ease: 'easeInOut', repeat: Infinity, repeatType: 'mirror' }}
                    >
                      <g filter="url(#mistBlur)" fill="#F1F5F9">
                        <ellipse cx="500" cy="430" rx="700" ry="130" opacity="0.95" />
                        <ellipse cx="1250" cy="400" rx="720" ry="120" opacity="0.95" />
                        <ellipse cx="-200" cy="460" rx="600" ry="120" opacity="0.9" />
                        <ellipse cx="1900" cy="450" rx="600" ry="120" opacity="0.9" />
                      </g>
                    </motion.g>
                  </motion.g>
                  <motion.g
                    animate={reduce ? undefined : { x: [-90, 90] }}
                    transition={{ duration: 25, ease: 'easeInOut', repeat: Infinity, repeatType: 'mirror' }}
                  >
                    <g filter="url(#mistBlur)" fill="#F8FAFC">
                      <ellipse cx="300" cy="560" rx="420" ry="60" opacity="0.8" />
                      <ellipse cx="900" cy="520" rx="520" ry="70" opacity="0.75" />
                      <ellipse cx="1450" cy="570" rx="440" ry="60" opacity="0.8" />
                      <ellipse cx="-250" cy="600" rx="420" ry="70" opacity="0.7" />
                      <ellipse cx="1950" cy="590" rx="420" ry="70" opacity="0.7" />
                    </g>
                  </motion.g>
                </motion.svg>
              </motion.div>
              </Dolly>

              {/* Display type (z-10): behind the hiker, so he becomes the "I" */}
              <Dolly from={1.12} z="z-10" reduce={reduce}>
              <motion.div className="absolute inset-0" style={{ y: yText }}>
                <svg {...layerSvgProps}>
                  <motion.g
                    initial={reduce ? false : { opacity: 0, y: 18 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={show(2.7, 0.9)}
                    fontFamily="'Plus Jakarta Sans', 'DM Sans', system-ui, sans-serif"
                    fontWeight={800}
                    textAnchor="middle"
                    fill="#111827"
                  >
                    <text x="800" y="338" fontSize="42" letterSpacing="9">GO BEYOND</text>
                    <text x="800" y="384" fontSize="30" letterSpacing="9">THE</text>
                  </motion.g>
                  <g fontFamily="'Plus Jakarta Sans', 'DM Sans', system-ui, sans-serif" fontWeight={800} fill="#EA580C" fontSize="285">
                    <motion.text
                      x="735"
                      y="640"
                      textAnchor="end"
                      letterSpacing="14"
                      initial={reduce ? false : { opacity: 0, x: 150 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={show(3.3, 1.4)}
                    >
                      HOR
                    </motion.text>
                    <motion.text
                      x="865"
                      y="640"
                      textAnchor="start"
                      letterSpacing="14"
                      initial={reduce ? false : { opacity: 0, x: -150 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={show(3.3, 1.4)}
                    >
                      ZON
                    </motion.text>
                  </g>
                </svg>
              </motion.div>
              </Dolly>

              {/* Front mist (z-15) with fast wisps */}
              <Dolly from={1.25} z="z-[15]" reduce={reduce}>
              <motion.div className="absolute inset-0" style={{ y: yMistFront }}>
                <svg {...layerSvgProps}>
                  <motion.g
                    animate={reduce ? undefined : { x: [-260, 260] }}
                    transition={{ duration: 11, ease: 'easeInOut', repeat: Infinity, repeatType: 'mirror' }}
                  >
                    <g filter="url(#mistBlur)" fill="#F8FAFC" opacity="0.55">
                      <ellipse cx="300" cy="690" rx="320" ry="16" />
                      <ellipse cx="1150" cy="660" rx="380" ry="14" />
                      <ellipse cx="1600" cy="720" rx="300" ry="16" />
                    </g>
                  </motion.g>
                  <motion.g
                    animate={reduce ? undefined : { x: [70, -70] }}
                    transition={{ duration: 18, ease: 'easeInOut', repeat: Infinity, repeatType: 'mirror' }}
                  >
                    <g filter="url(#mistBlur)" fill="#E2E8F0">
                      <ellipse cx="200" cy="740" rx="430" ry="55" opacity="0.8" />
                      <ellipse cx="1000" cy="720" rx="520" ry="50" opacity="0.55" />
                      <ellipse cx="1500" cy="760" rx="420" ry="55" opacity="0.8" />
                      <ellipse cx="-300" cy="760" rx="420" ry="55" opacity="0.7" />
                    </g>
                  </motion.g>
                </svg>
              </motion.div>
              </Dolly>

              {/* Foreground rock and hiker (z-20) */}
              <Dolly from={1.12} z="z-20" reduce={reduce}>
              <motion.div className="absolute inset-0" style={{ y: yFront }}>
                <svg {...layerSvgProps}>
                  <defs>
                    <linearGradient id="rockGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor="#3B4656" />
                      <stop offset="0.35" stopColor="#1F2937" />
                      <stop offset="1" stopColor="#070B14" />
                    </linearGradient>
                  </defs>
                  <motion.path
                    d={pines.front}
                    fill="#0B1220"
                    style={{ originX: 0.5, originY: 1 }}
                    animate={reduce ? undefined : { rotate: [-0.7, 0.8] }}
                    transition={{ duration: 5, ease: 'easeInOut', repeat: Infinity, repeatType: 'mirror' }}
                  />
                  {/* Shrubs beside the rock */}
                  <g fill="#1E293B">
                    <ellipse cx="330" cy="830" rx="110" ry="40" />
                    <ellipse cx="450" cy="805" rx="90" ry="38" />
                    <ellipse cx="1130" cy="835" rx="100" ry="36" />
                  </g>
                  <path
                    d="M-700 1200 L-700 900 L-200 870 L260 850 L470 828 L600 790 L670 770 L730 768 L790 772 L850 770 L920 776 L990 788 L1100 810 L1250 838 L1500 862 L2000 880 L2300 900 L2300 1200 Z"
                    fill="url(#rockGrad)"
                  />
                  <path
                    d="M600 790 L670 770 L730 768 L790 772 L850 770 L920 776 L990 788 L1100 810"
                    fill="none"
                    stroke="#94A3B8"
                    strokeWidth="2"
                    strokeLinejoin="round"
                    opacity="0.5"
                  />
                  <g stroke="#0B1220" strokeWidth="2" fill="none" opacity="0.75" strokeLinecap="round">
                    <path d="M640 800 L690 830 L676 870" />
                    <path d="M900 782 L930 826 L910 880" />
                    <path d="M1010 800 L1060 840 L1040 890" />
                    <path d="M520 830 L560 860 L545 900" />
                  </g>
                  <Hiker reduce={reduce} />
                </svg>
              </motion.div>
              </Dolly>
            </motion.div>
          </div>

          {/* Soft vignette so the bar and edges read against the rock */}
          <div
            className="pointer-events-none absolute inset-0 z-[25]"
            style={{ background: 'radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(15,23,42,0.35) 100%)' }}
          />

          {/* Brand and skip */}
          <div className="absolute left-5 right-5 top-5 z-[40] flex items-center justify-between sm:left-8 sm:right-8 sm:top-6">
            <span className="text-sm font-extrabold uppercase tracking-[0.28em] text-[#111827]" style={{ fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}>
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
