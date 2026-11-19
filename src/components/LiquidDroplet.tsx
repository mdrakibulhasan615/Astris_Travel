import { useEffect, useRef } from 'react';
import { refraction, watchGlassRefraction } from '../liquidRefraction.ts';

/**
 * Liquid-glass selection droplets, like the lens on Apple devices' tab bars. Every control's selected
 * item (a tab, a segmented toggle, a filter chip, a menu choice: anything marked aria-selected,
 * aria-pressed, aria-checked or aria-current) wears a clear glass droplet:
 *  - it takes the item's size and corner radius;
 *  - when the selection moves to another item in the same control, the droplet glides over on a
 *    spring, stretching in the direction it moves like a drop of water, and re-moulds to the new item;
 *  - while the pointer is over the selected item it leans towards the cursor, with a highlight under
 *    it, and pressing swells it.
 * Unselected buttons get nothing. The droplet bends the background at its edges (see
 * liquidRefraction.ts) but never blurs, so the label underneath stays sharp.
 *
 * Also starts the edge refraction for every glass surface. One requestAnimationFrame loop for all
 * droplets, which sleeps when nothing moves.
 */

const SELECTED =
  '[aria-selected="true"], [aria-pressed="true"], [aria-checked="true"], [aria-current="page"], [aria-current="true"]';
const GROUP = '[role="tablist"], [role="radiogroup"], [role="listbox"], [role="menu"], [role="group"], nav';
const MAX_W = 360; // bigger things (whole cards, tickets) get no droplet
const MAX_H = 72;
const PAD = 3; // the droplet sits just outside the item's edge

interface Spring {
  x: number;
  v: number;
}

interface Droplet {
  node: HTMLDivElement;
  el: Element | null;
  cx: Spring;
  cy: Spring;
  w: Spring;
  h: Spring;
  show: Spring;
  swell: Spring;
  refractKey: string;
}

const spring = (x: number): Spring => ({ x, v: 0 });

function step(s: Spring, target: number, k: number, damping: number, frames: number) {
  for (let i = 0; i < frames; i++) {
    s.v = (s.v + (target - s.x) * k) * damping;
    s.x += s.v;
  }
}

function usable(el: Element): DOMRect | null {
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4 || r.width > MAX_W || r.height > MAX_H) return null;
  if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return null;
  // Hidden behind something (a modal, a menu): no droplet floating on top of it
  const x = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2));
  const y = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
  const top = document.elementFromPoint(x, y);
  if (top && top !== el && !el.contains(top) && !top.contains(el)) return null;
  return r;
}

export function LiquidDroplet() {
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => watchGlassRefraction(), []);

  useEffect(() => {
    const root = layer.current;
    if (!root) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // One list of droplets per control; the n-th selected item of a control keeps the n-th droplet,
    // so when the selection moves, the same droplet travels
    const groups = new Map<Element, Droplet[]>();
    let pointer = { x: -1, y: -1 };
    let pressed: Element | null = null;
    let raf = 0;
    let last = 0;

    const make = (): Droplet => {
      const node = document.createElement('div');
      node.className = 'liquid-droplet';
      root.appendChild(node);
      return { node, el: null, cx: spring(0), cy: spring(0), w: spring(0), h: spring(0), show: spring(0), swell: spring(1), refractKey: '' };
    };

    const sync = () => {
      const current = new Map<Element, Element[]>();
      document.querySelectorAll(SELECTED).forEach((el) => {
        if (root.contains(el)) return;
        const group = el.parentElement?.closest(GROUP) ?? el.parentElement ?? el;
        const list = current.get(group) ?? [];
        list.push(el);
        current.set(group, list);
      });
      // Retire droplets of controls that no longer have a selection
      groups.forEach((drops, group) => {
        if (!current.has(group)) drops.forEach((d) => (d.el = null));
      });
      current.forEach((els, group) => {
        const drops = groups.get(group) ?? [];
        els.forEach((el, i) => {
          let d = drops[i];
          if (!d) {
            d = make();
            drops[i] = d;
          }
          if (d.el !== el && d.show.x < 0.05) {
            // Appearing (not travelling): start small, in the middle of the item
            const r = el.getBoundingClientRect();
            d.cx.x = r.left + r.width / 2;
            d.cy.x = r.top + r.height / 2;
            d.w.x = r.width * 0.55;
            d.h.x = r.height * 0.55;
            d.cx.v = d.cy.v = d.w.v = d.h.v = 0;
          }
          d.el = el;
        });
        for (let i = els.length; i < drops.length; i++) drops[i].el = null;
        groups.set(group, drops);
      });
      wake();
    };

    const frame = (now: number) => {
      const frames = Math.min(4, Math.max(1, Math.round((now - last) / 16.7)));
      last = now;
      let moving = false;

      groups.forEach((drops, group) => {
        drops.forEach((d, i) => {
          const r = d.el && d.el.isConnected ? usable(d.el) : null;
          let radius = parseFloat(d.node.style.borderRadius) || 12;
          if (r && d.el) {
            const mx = r.left + r.width / 2;
            const my = r.top + r.height / 2;
            const over = pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom;
            // Lean towards the cursor while it is over the selected item: the droplet moulds as it moves
            const lean = over ? 0.16 : 0;
            step(d.cx, mx + (pointer.x - mx) * lean, 0.17, 0.72, frames);
            step(d.cy, my + (pointer.y - my) * lean, 0.17, 0.72, frames);
            // Labels that run to the item's edge (no side padding) get extra room, so the droplet's
            // bent rim doesn't sit on the text
            const cs = getComputedStyle(d.el);
            const padX = Math.max(PAD, 12 - (parseFloat(cs.paddingLeft) || 0));
            step(d.w, r.width + padX * 2, 0.15, 0.7, frames);
            step(d.h, r.height + PAD * 2, 0.15, 0.7, frames);
            step(d.show, 1, 0.18, 0.66, frames);
            step(d.swell, pressed && (pressed === d.el || d.el.contains(pressed)) ? 1.07 : 1, 0.25, 0.6, frames);
            const br = parseFloat(cs.borderTopLeftRadius) || 0;
            radius = Math.min(Math.max(br, 10) + PAD, (r.height + PAD * 2) / 2);
          } else {
            step(d.show, 0, 0.2, 0.62, frames);
            step(d.swell, 1, 0.25, 0.6, frames);
          }

          // Stretch along the direction of travel, thinner across it
          const speed = Math.hypot(d.cx.v, d.cy.v);
          const stretch = 1 + Math.min(0.35, speed / 45);
          const angle = Math.atan2(d.cy.v, d.cx.v);
          const width = Math.max(0, d.w.x);
          const height = Math.max(0, d.h.x);
          const opacity = Math.max(0, Math.min(1, d.show.x));
          const scale = d.swell.x * (0.8 + 0.2 * opacity);
          const s = d.node.style;
          s.width = `${width.toFixed(1)}px`;
          s.height = `${height.toFixed(1)}px`;
          s.borderRadius = `${radius.toFixed(1)}px`;
          s.opacity = opacity.toFixed(3);
          s.transform =
            `translate(${(d.cx.x - width / 2).toFixed(1)}px, ${(d.cy.x - height / 2).toFixed(1)}px) ` +
            `rotate(${angle}rad) scale(${stretch.toFixed(3)}, ${(1 / stretch).toFixed(3)}) rotate(${-angle}rad) scale(${scale.toFixed(3)})`;
          const hx = pointer.x >= 0 && width ? ((pointer.x - (d.cx.x - width / 2)) / width) * 100 : 50;
          const hy = pointer.y >= 0 && height ? ((pointer.y - (d.cy.x - height / 2)) / height) * 100 : 25;
          s.setProperty('--hx', `${Math.max(-20, Math.min(120, hx)).toFixed(1)}%`);
          s.setProperty('--hy', `${Math.max(-20, Math.min(120, hy)).toFixed(1)}%`);
          // Edge refraction sized to the droplet (sizes are bucketed, so this rarely makes a new filter)
          const key = `${Math.round(width / 4)}x${Math.round(height / 4)}`;
          if (key !== d.refractKey) {
            d.refractKey = key;
            const url = refraction(width, height, 0.4);
            if (url) s.setProperty('--lg-refract', url);
          }

          const settled =
            Math.abs(d.cx.v) + Math.abs(d.cy.v) + Math.abs(d.w.v) + Math.abs(d.h.v) + Math.abs(d.show.v) + Math.abs(d.swell.v) < 0.02;
          if (!settled) moving = true;
          // Fully faded and detached: remove it
          if (!d.el && opacity < 0.01 && settled) {
            d.node.remove();
            drops.splice(i, 1);
          }
        });
        if (!drops.length) groups.delete(group);
      });

      raf = moving ? requestAnimationFrame(frame) : 0;
    };

    const wake = () => {
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };

    const onMove = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      wake();
    };
    const onDown = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      pressed = e.target instanceof Element ? e.target : null;
      wake();
    };
    const onUp = () => {
      pressed = null;
      wake();
    };
    const onLeave = () => {
      pointer = { x: -1, y: -1 };
      pressed = null;
      wake();
    };

    // Selection changes, new controls, layout changes: re-sync (batched to one per frame)
    let queued = 0;
    const queue = () => {
      if (queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        sync();
      });
    };
    const observer = new MutationObserver(queue);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-selected', 'aria-pressed', 'aria-checked', 'aria-current', 'class'],
    });
    const settle = window.setInterval(wake, 600); // catches layout shifts nothing else reports
    sync();

    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerdown', onDown, { passive: true });
    document.addEventListener('pointerup', onUp, { passive: true });
    document.addEventListener('pointercancel', onUp, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    window.addEventListener('scroll', wake, { passive: true, capture: true });
    window.addEventListener('resize', wake);
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(queued);
      window.clearInterval(settle);
      observer.disconnect();
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('scroll', wake, { capture: true });
      window.removeEventListener('resize', wake);
      root.replaceChildren();
    };
  }, []);

  return <div ref={layer} aria-hidden="true" className="pointer-events-none fixed inset-0 z-[9990]" />;
}
