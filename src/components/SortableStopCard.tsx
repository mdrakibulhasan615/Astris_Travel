import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Calendar, GripVertical, Minus, Plus, Trash2 } from 'lucide-react';
import type { TripStop } from '../../shared/types.ts';

interface SortableStopCardProps {
  stop: TripStop;
  index: number;
  /** The first stop is the departure point: it has a departure date, not a stay. */
  isOrigin: boolean;
  isHovered: boolean;
  canRemove: boolean;
  onHoverStop: (stopId: string | null) => void;
  onFocusStop: (stop: TripStop) => void;
  onOpenDatePicker: (stopId: string) => void;
  onUpdateNights: (stopId: string, delta: number) => void;
  onRemoveStop: (stopId: string) => void;
}

export function SortableStopCard({
  stop,
  index,
  isOrigin,
  isHovered,
  canRemove,
  onHoverStop,
  onFocusStop,
  onOpenDatePicker,
  onUpdateNights,
  onRemoveStop,
}: SortableStopCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: stop.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      onMouseEnter={() => onHoverStop(stop.id)}
      onMouseLeave={() => onHoverStop(null)}
      className={`rounded-2xl bg-white border px-4 py-3 transition-all ${
        isDragging
          ? 'opacity-80 shadow-lg border-[#FF812E] z-20'
          : isHovered
            ? 'border-[#FFD6BA] bg-[#FFF4ED]/40 shadow-md'
            : 'border-neutral-200/80 shadow-sm hover:shadow-md'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            aria-label={`Reorder ${stop.city}`}
            {...attributes}
            {...listeners}
            className="p-1 -ml-1 rounded-lg text-neutral-400 hover:text-[#111827] hover:bg-neutral-100 cursor-grab active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E]"
          >
            <GripVertical className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => onFocusStop(stop)}
            className="w-7 h-7 rounded-full bg-[#FF812E] text-white font-display text-xs font-bold flex items-center justify-center shrink-0 ring-2 ring-white shadow-sm hover:bg-[#E56B1A] transition-colors cursor-pointer"
          >
            {index + 1}
          </button>

          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <button
                type="button"
                onClick={() => onFocusStop(stop)}
                className="font-display text-sm font-bold text-[#111827] hover:text-[#E56B1A] transition-colors text-left cursor-pointer"
              >
                {stop.city}
              </button>
              <span className="text-xs text-[#4B5563] truncate">
                {stop.country} · <span className="font-mono">{stop.iataCode}</span>
              </span>
              {isOrigin && (
                <span className="rounded-md bg-[#FFF4ED] border border-[#FFD6BA] px-1.5 py-px text-[10px] font-semibold text-[#E56B1A]">
                  Trip start
                </span>
              )}
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-mono text-[#4B5563] tabular-nums">
              <button
                type="button"
                onClick={() => onOpenDatePicker(stop.id)}
                aria-label={
                  isOrigin ? `Edit departure date from ${stop.city}` : `Edit dates for ${stop.city}`
                }
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg border border-neutral-200/80 bg-neutral-50/80 hover:bg-[#FFF4ED] hover:border-[#FFD6BA] hover:text-[#111827] transition-colors cursor-pointer"
              >
                <Calendar className="w-3 h-3 text-[#FF812E] shrink-0" />
                <span>
                  {isOrigin
                    ? `Departs ${stop.departureDate}`
                    : `${stop.arrivalDate} → ${stop.departureDate}`}
                </span>
              </button>
              <span aria-hidden="true">·</span>
              <span>
                {stop.lat.toFixed(2)}, {stop.lng.toFixed(2)}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {!isOrigin && (
          <div className="inline-flex items-center rounded-xl border border-neutral-200 bg-neutral-50/70 p-0.5">
            <button
              type="button"
              aria-label={`Decrease nights in ${stop.city}`}
              onClick={() => onUpdateNights(stop.id, -1)}
              disabled={stop.stayNights <= 1}
              className="w-6 h-6 flex items-center justify-center rounded-lg text-[#4B5563] hover:text-[#111827] hover:bg-white disabled:opacity-40 transition-colors cursor-pointer"
            >
              <Minus className="w-3 h-3" />
            </button>
            <span className="px-2 font-mono text-xs font-semibold text-[#111827] tabular-nums whitespace-nowrap">
              {stop.stayNights}n
            </span>
            <button
              type="button"
              aria-label={`Increase nights in ${stop.city}`}
              onClick={() => onUpdateNights(stop.id, 1)}
              className="w-6 h-6 flex items-center justify-center rounded-lg text-[#4B5563] hover:text-[#111827] hover:bg-white transition-colors cursor-pointer"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>
          )}

          {canRemove && (
            <button
              type="button"
              aria-label={`Remove ${stop.city}`}
              onClick={() => onRemoveStop(stop.id)}
              className="w-7 h-7 flex items-center justify-center rounded-xl text-neutral-400 hover:text-[#DC2626] hover:bg-red-50 transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
