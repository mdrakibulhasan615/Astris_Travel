import { useMemo } from 'react';
import { Bus, Plane, Sparkles, TrainFront } from 'lucide-react';
import type { ModeFilter, TripLeg } from '../../shared/types.ts';

const ITEMS = [
  { id: 'all', label: 'All', icon: Sparkles, dot: '#111827' },
  { id: 'flight', label: 'Flights', icon: Plane, dot: '#FF812E' },
  { id: 'train', label: 'Trains', icon: TrainFront, dot: '#7C3AED' },
  { id: 'bus', label: 'Buses', icon: Bus, dot: '#0D9488' },
] as const;

/**
 * Filters the ticket list (and the map lines) by transport mode. Sits above the itinerary so it
 * applies to every leg's options at once; each chip shows how many options it would leave.
 */
export function TransportFilter({
  legs,
  value,
  onChange,
}: {
  legs: TripLeg[];
  value: ModeFilter;
  onChange: (mode: ModeFilter) => void;
}) {
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0, flight: 0, train: 0, bus: 0 };
    for (const leg of legs) {
      for (const opt of leg.transitOptions) {
        c.all += 1;
        c[opt.mode] = (c[opt.mode] ?? 0) + 1;
      }
    }
    return c;
  }, [legs]);

  return (
    <div
      role="group"
      aria-label="Filter tickets by transport mode"
      className="flex flex-wrap items-center gap-1.5"
    >
      {ITEMS.map((item) => {
        const Icon = item.icon;
        const active = value === item.id;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(item.id)}
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E] ${
              active
                ? 'border-[#FF812E] bg-[#FF812E] text-white shadow-sm'
                : 'border-neutral-200 bg-white text-[#4B5563] hover:border-neutral-300 hover:text-[#111827]'
            }`}
          >
            <Icon className="h-3.5 w-3.5" style={{ color: active ? '#FFFFFF' : item.dot }} aria-hidden="true" />
            <span>{item.label}</span>
            <span className={`font-mono text-[11px] tabular-nums ${active ? 'text-white/90' : 'text-neutral-400'}`}>
              {counts[item.id] ?? 0}
            </span>
          </button>
        );
      })}
    </div>
  );
}
