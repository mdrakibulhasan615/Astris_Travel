import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

/**
 * The little pill on the split between the tickets and the map. Drag it sideways to give the
 * tickets or the map more room (double-click puts it back, and the arrow keys nudge it). It only
 * asks for a width: the caller clamps it to the limits (the narrowest the tickets stay readable,
 * and a minimum for the map) and passes the clamped value back in as `left`.
 */
export function SplitHandle({
  left,
  min,
  max,
  onDrag,
  onCommit,
  onReset,
}: {
  /** Where the split sits, in px from the left edge of the workspace. */
  left: number;
  min: number;
  max: number;
  /** While dragging: the pointer's distance from the workspace's left edge, in px. */
  onDrag: (px: number) => void;
  /** Drag or key press finished: save it. */
  onCommit: () => void;
  onReset: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const originX = useRef(0);
  const el = useRef<HTMLDivElement>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Distance from the workspace's left edge to the pointer, minus where the split already is
    originX.current = (el.current?.parentElement?.getBoundingClientRect().left ?? 0);
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    onDrag(e.clientX - originX.current);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    onCommit();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 80 : 24;
    if (e.key === 'ArrowLeft') onDrag(left - step);
    else if (e.key === 'ArrowRight') onDrag(left + step);
    else if (e.key === 'Home') onDrag(min);
    else if (e.key === 'End') onDrag(max);
    else return;
    e.preventDefault();
    onCommit();
  };

  return (
    <div
      ref={el}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize tickets and map"
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(left)}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      style={{ left }}
      className="group absolute top-1/2 z-40 hidden h-24 w-5 -translate-x-1/2 -translate-y-1/2 cursor-col-resize touch-none select-none items-center justify-center focus-visible:outline-none lg:flex"
    >
      <span
        className={`block rounded-full glass-control shadow-[0_2px_10px_rgba(17,24,39,0.28)] ring-1 ring-[#111827]/20 transition-[width,height,background-color] duration-150 group-focus-visible:ring-2 group-focus-visible:ring-[#FF812E] ${
          dragging ? 'h-16 w-2 !bg-white' : 'h-12 w-1.5 group-hover:h-14 group-hover:w-2'
        }`}
      />
    </div>
  );
}
