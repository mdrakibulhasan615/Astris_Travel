import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeftRight,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Plus,
  Sparkles,
  X,
} from 'lucide-react';
import type { DestinationHub, TripLeg, TripStop } from '../../shared/types.ts';

export type SegmentChoice = 'one-way' | 'return' | 'auto';

interface RouteBarProps {
  stops: TripStop[];
  legs: TripLeg[];
  /** Popular destinations offered before anything is typed (and as the offline fallback). */
  destinations: DestinationHub[];
  hoveredStopId: string | null;
  onMoveStop: (fromIndex: number, toIndex: number) => void;
  onRemoveStop: (stopId: string) => void;
  onAddDestination: (hub: DestinationHub) => void;
  onChangeSegment: (legId: string, choice: SegmentChoice) => void;
  onHoverStop: (stopId: string | null) => void;
  onFocusStop: (stop: TripStop) => void;
  /** `map` floats over the map (default); `hero` sits in normal flow on the landing page. */
  variant?: 'map' | 'hero';
}

// ── A menu that floats above the bar's scroll area (a plain absolute menu would be clipped) ──────

function FloatingMenu({
  anchor,
  open,
  onClose,
  width = 260,
  label,
  children,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  width?: number;
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      setPos({
        left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
        top: r.bottom + 8,
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchor, width]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open, anchor, onClose]);

  if (!open || !pos) return null;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      style={{ position: 'fixed', left: pos.left, top: pos.top, width }}
      className="z-[70] rounded-2xl border border-neutral-200 bg-white p-1.5 shadow-xl"
    >
      {children}
    </div>,
    document.body
  );
}

function MenuItem({
  icon,
  title,
  hint,
  active,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
      className={`flex w-full cursor-pointer items-start gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-[#FFF4ED] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E] ${
        active ? 'bg-[#FFF4ED]' : ''
      }`}
    >
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-[#111827]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold text-[#111827]">{title}</span>
        <span className="block text-[11px] leading-snug text-[#4B5563]">{hint}</span>
      </span>
      {active && <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-[#FF812E]" aria-hidden="true" />}
    </button>
  );
}

// ── The connector between two stops: → one-way, ⇄ return ─────────────────────────────────────────

function SegmentConnector({
  from,
  to,
  leg,
  coveredBy,
  onChange,
}: {
  from: TripStop;
  to: TripStop;
  leg: TripLeg | undefined;
  coveredBy: TripLeg | undefined;
  onChange: (legId: string, choice: SegmentChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);

  const isReturn = Boolean(coveredBy) || leg?.ticketType === 'return';
  const current: SegmentChoice = coveredBy ? 'return' : !leg?.ticketLocked ? 'auto' : isReturn ? 'return' : 'one-way';
  const Icon = isReturn ? ArrowLeftRight : ArrowRight;
  const description = coveredBy
    ? `${from.city} to ${to.city}: covered by a return ticket`
    : `${from.city} to ${to.city}: ${isReturn ? 'return' : 'one-way'}${!leg?.ticketLocked ? ' (auto)' : ''}. Click to change.`;

  if (!leg && !coveredBy) {
    // Same place twice in a row: no ticket to choose
    return <span aria-hidden="true" className="px-1 text-neutral-300"><ArrowRight className="h-4 w-4" /></span>;
  }

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={description}
        title={description}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-7 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E] ${
          isReturn
            ? 'border-[#FFD6BA] bg-[#FFF4ED] text-[#E56B1A]'
            : 'border-neutral-200 bg-white/80 text-[#4B5563] hover:border-neutral-300 hover:text-[#111827]'
        } ${coveredBy ? 'opacity-70' : ''}`}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </button>
      <FloatingMenu anchor={anchor} open={open} onClose={() => setOpen(false)} label={`Ticket type for ${from.city} to ${to.city}`}>
        {coveredBy ? (
          <MenuItem
            icon={<ArrowRight className="h-3.5 w-3.5" />}
            title="Book one-way tickets instead"
            hint={`This leg is covered by the return ticket on ${coveredBy.fromCity} to ${coveredBy.toCity}.`}
            onClick={() => {
              onChange(coveredBy.id, 'one-way');
              setOpen(false);
            }}
          />
        ) : (
          <>
            <MenuItem
              icon={<ArrowRight className="h-3.5 w-3.5" />}
              title="One-way"
              hint={`A single ticket from ${from.city} to ${to.city}.`}
              active={current === 'one-way'}
              onClick={() => {
                if (leg) onChange(leg.id, 'one-way');
                setOpen(false);
              }}
            />
            <MenuItem
              icon={<ArrowLeftRight className="h-3.5 w-3.5" />}
              title="Return"
              hint={`Round trip, back to ${from.city}. Covers the way back in your route.`}
              active={current === 'return'}
              onClick={() => {
                if (leg) onChange(leg.id, 'return');
                setOpen(false);
              }}
            />
            <MenuItem
              icon={<Sparkles className="h-3.5 w-3.5" />}
              title="Best price (auto)"
              hint="Compare one-way and return fares and pick the cheaper."
              active={current === 'auto'}
              onClick={() => {
                if (leg) onChange(leg.id, 'auto');
                setOpen(false);
              }}
            />
          </>
        )}
      </FloatingMenu>
    </>
  );
}

// ── "Add a stop…" with suggestions ───────────────────────────────────────────────────────────────

function AddStopInput({
  destinations,
  onAdd,
}: {
  destinations: DestinationHub[];
  onAdd: (hub: DestinationHub) => void;
}) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [results, setResults] = useState<DestinationHub[]>(destinations);
  const [highlight, setHighlight] = useState(0);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(destinations.slice(0, 8));
      setHighlight(0);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/airports/search?q=${encodeURIComponent(q)}&limit=8`, { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          setResults((data.results as DestinationHub[]) ?? []);
          setHighlight(0);
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        const lower = q.toLowerCase();
        setResults(
          destinations
            .filter((d) => [d.city, d.country, d.iataCode].some((v) => v.toLowerCase().includes(lower)))
            .slice(0, 8)
        );
      }
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, destinations]);

  const choose = (hub: DestinationHub) => {
    onAdd(hub);
    setQuery('');
    setFocused(false);
    inputRef.current?.blur();
  };

  return (
    <>
      <div
        ref={setAnchor}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-dashed border-neutral-300 bg-white/70 pl-2.5 pr-3 focus-within:border-[#FF812E]"
      >
        <Plus className="h-3.5 w-3.5 text-[#6B7280]" aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && results.length) {
              e.preventDefault();
              setHighlight((h) => (h + 1) % results.length);
            } else if (e.key === 'ArrowUp' && results.length) {
              e.preventDefault();
              setHighlight((h) => (h - 1 + results.length) % results.length);
            } else if (e.key === 'Enter' && results[highlight]) {
              e.preventDefault();
              choose(results[highlight]);
            } else if (e.key === 'Escape') {
              setFocused(false);
              inputRef.current?.blur();
            }
          }}
          placeholder="Add a stop…"
          aria-label="Add a stop"
          role="combobox"
          aria-expanded={focused && results.length > 0}
          aria-autocomplete="list"
          className="w-24 bg-transparent text-xs text-[#111827] placeholder:text-[#6B7280] focus:w-36 focus:outline-none"
          style={{ transition: 'width 150ms ease' }}
        />
      </div>
      <FloatingMenu anchor={anchor} open={focused && results.length > 0} onClose={() => setFocused(false)} width={300} label="Destination suggestions">
        <div className="max-h-72 overflow-y-auto">
          {results.map((h, i) => (
            <button
              key={`${h.iataCode}-${h.city}-${i}`}
              type="button"
              role="option"
              aria-selected={i === highlight}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => choose(h)}
              className={`flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left ${
                i === highlight ? 'bg-[#FFF4ED]' : ''
              }`}
            >
              <MapPin className="h-3.5 w-3.5 shrink-0 text-[#FF812E]" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-xs">
                <span className="font-semibold text-[#111827]">{h.city}</span>
                <span className="text-[#4B5563]">, {h.country}</span>
              </span>
              <span className="font-mono text-[11px] text-[#6B7280]">{h.iataCode}</span>
            </button>
          ))}
        </div>
      </FloatingMenu>
    </>
  );
}

// ── The bar ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The trip at a glance, floating over the map: one pill per stop in order, a connector between
 * them showing one-way (→) or return (⇄) that opens a menu to change it, drag handles and arrows to
 * reorder, an inline "Add a stop…" field, (adding or changing a stop searches again automatically). It edits the same trip state as
 * the itinerary list, so the two always agree.
 */
export function RouteBar({
  stops,
  legs,
  destinations,
  hoveredStopId,
  onMoveStop,
  onRemoveStop,
  onAddDestination,
  onChangeSegment,
  onHoverStop,
  onFocusStop,
  variant = 'map',
}: RouteBarProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const legBetween = (a: TripStop, b: TripStop) => legs.find((l) => l.fromStopId === a.id && l.toStopId === b.id);

  return (
    <div
      className={
        variant === 'hero'
          ? 'w-full'
          : 'pointer-events-none absolute left-3 right-3 top-3 z-30 sm:left-4 sm:right-4'
      }
    >
      <div
        role="group"
        aria-label="Trip route"
        className={`pointer-events-auto flex items-start gap-2 rounded-2xl border border-white/50 ${variant === 'hero' ? 'bg-white/90 shadow-2xl' : 'bg-white/80 shadow-lg'} p-1.5 pl-2 backdrop-blur-md`}
      >
        <ol
          aria-label="Stops in order"
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-1.5 py-0.5"
        >
          {stops.map((stop, i) => {
            const next = stops[i + 1];
            const leg = next ? legBetween(stop, next) : undefined;
            // A leg the traveller's return ticket already covers shows ⇄ and points at that ticket
            const coveredBy = leg?.coveredByLegId ? legs.find((l) => l.id === leg.coveredByLegId) : undefined;
            return (
              <li key={stop.id} className="flex shrink-0 items-center gap-1">
                <div
                  draggable
                  onDragStart={(e) => {
                    setDragIndex(i);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', stop.id);
                  }}
                  onDragOver={(e) => {
                    if (dragIndex === null) return;
                    e.preventDefault();
                    setOverIndex(i);
                  }}
                  onDragLeave={() => setOverIndex((o) => (o === i ? null : o))}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragIndex !== null && dragIndex !== i) onMoveStop(dragIndex, i);
                    setDragIndex(null);
                    setOverIndex(null);
                  }}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setOverIndex(null);
                  }}
                  onMouseEnter={() => onHoverStop(stop.id)}
                  onMouseLeave={() => onHoverStop(null)}
                  className={`group flex h-8 cursor-grab items-center gap-1.5 rounded-full border bg-white pl-1.5 pr-2 text-xs shadow-sm transition-colors active:cursor-grabbing ${
                    overIndex === i && dragIndex !== i
                      ? 'border-[#FF812E] ring-2 ring-[#FF812E]/30'
                      : hoveredStopId === stop.id
                        ? 'border-[#FFD6BA] bg-[#FFF4ED]'
                        : 'border-neutral-200'
                  } ${dragIndex === i ? 'opacity-50' : ''}`}
                >
                  <span
                    aria-hidden="true"
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#FF812E] font-mono text-[10px] font-bold text-white"
                  >
                    {i + 1}
                  </span>
                  <button
                    type="button"
                    onClick={() => onFocusStop(stop)}
                    title={`${stop.city}, ${stop.country}: show on the map`}
                    className="max-w-[9rem] cursor-pointer truncate font-semibold text-[#111827] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E]"
                  >
                    {stop.city}
                  </button>
                  {/* Reorder and remove: slide out on hover or keyboard focus */}
                  <span className="flex max-w-0 items-center gap-0.5 overflow-hidden opacity-0 transition-all duration-150 group-focus-within:max-w-[5.5rem] group-focus-within:opacity-100 group-hover:max-w-[5.5rem] group-hover:opacity-100">
                    <button
                      type="button"
                      disabled={i === 0}
                      onClick={() => onMoveStop(i, i - 1)}
                      aria-label={`Move ${stop.city} earlier`}
                      className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-full text-[#4B5563] hover:bg-neutral-100 disabled:cursor-default disabled:opacity-30"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      disabled={i === stops.length - 1}
                      onClick={() => onMoveStop(i, i + 1)}
                      aria-label={`Move ${stop.city} later`}
                      className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-full text-[#4B5563] hover:bg-neutral-100 disabled:cursor-default disabled:opacity-30"
                    >
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    {stops.length > 1 && (
                      <button
                        type="button"
                        onClick={() => onRemoveStop(stop.id)}
                        aria-label={`Remove ${stop.city}`}
                        className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-full text-[#B91C1C] hover:bg-[#FEF2F2]"
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </span>
                </div>
                {next && (
                  <SegmentConnector
                    from={stop}
                    to={next}
                    leg={leg}
                    coveredBy={coveredBy}
                    onChange={onChangeSegment}
                  />
                )}
              </li>
            );
          })}
          <li className="ml-1 shrink-0">
            <AddStopInput destinations={destinations} onAdd={onAddDestination} />
          </li>
        </ol>

      </div>
    </div>
  );
}
