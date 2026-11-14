import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, MapPin, Plane, Plus, Search, X } from 'lucide-react';
import type { DestinationHub, TripStop } from '../../shared/types.ts';

interface AddStopModalProps {
  isOpen: boolean;
  destinations: DestinationHub[];
  currentStops: TripStop[];
  onClose: () => void;
  onAddDestination: (hub: DestinationHub) => void;
}

export function AddStopModal({
  isOpen,
  destinations,
  currentStops,
  onClose,
  onAddDestination,
}: AddStopModalProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DestinationHub[]>(destinations);
  const [isLoading, setIsLoading] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);

  // How many times each place is already in the trip. Purely informational: a place can be added
  // again as often as the traveller likes (A → B → A, or a second pass through the same hub).
  const visitCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of currentStops) {
      const code = s.iataCode.toUpperCase();
      counts[code] = (counts[code] ?? 0) + 1;
    }
    return counts;
  }, [currentStops]);

  // Auto-focus input on open and reset state
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setResults(destinations);
      setHighlightedIndex(0);
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen, destinations]);

  // Live autocomplete search with 150ms debounce
  useEffect(() => {
    if (!isOpen) return;
    const q = query.trim();

    if (!q) {
      setResults(destinations);
      setIsLoading(false);
      setHighlightedIndex(0);
      return;
    }

    setIsLoading(true);
    const controller = new AbortController();

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/airports/search?q=${encodeURIComponent(q)}&limit=25`, {
          signal: controller.signal,
        });
        if (res.ok) {
          const data = await res.json();
          setResults(data.results || []);
          setHighlightedIndex(0);
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          // Client-side fallback
          const fallback = destinations.filter(
            (d) =>
              d.city.toLowerCase().includes(q.toLowerCase()) ||
              d.country.toLowerCase().includes(q.toLowerCase()) ||
              d.iataCode.toLowerCase().includes(q.toLowerCase())
          );
          setResults(fallback);
        }
      } finally {
        setIsLoading(false);
      }
    }, 150);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, isOpen, destinations]);

  const handleSelect = (hub: DestinationHub) => {
    onAddDestination(hub);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (results.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const current = results[highlightedIndex];
      if (current) {
        handleSelect(current);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add destination stop"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/35 backdrop-blur-xs"
    >
      <div className="w-full max-w-lg rounded-2xl bg-white border border-neutral-200 shadow-xl overflow-hidden flex flex-col max-h-[85vh]">
        <div className="px-5 py-4 border-b border-neutral-100 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-xl bg-[#FFF4ED] border border-[#FFD6BA] text-[#FF812E] flex items-center justify-center">
              <Plane className="w-4 h-4" />
            </span>
            <div>
              <h2 className="font-display text-base font-bold text-[#111827]">
                Add Destination Stop
              </h2>
              <div className="text-[11px] text-[#4B5563]">
                Search 6,300+ global airports by city, airport, or 3-letter IATA code
              </div>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close modal"
            onClick={onClose}
            className="w-8 h-8 rounded-xl flex items-center justify-center text-[#4B5563] hover:text-[#111827] hover:bg-neutral-100 transition-colors cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-3.5 flex-1 min-h-0 flex flex-col">
          <div className="relative shrink-0">
            <Search className="w-4 h-4 text-[#4B5563] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g., Tokyo, Haneda, HND, London, LHR, JFK..."
              className="w-full pl-10 pr-9 py-2.5 rounded-xl border border-neutral-200 text-sm text-[#111827] placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-[#FF812E] focus:border-transparent transition-all"
            />
            {isLoading ? (
              <Loader2 className="w-4 h-4 text-[#FF812E] animate-spin absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            ) : query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="w-5 h-5 rounded-full flex items-center justify-center text-neutral-400 hover:text-neutral-600 absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            ) : null}
          </div>

          <div className="flex items-center justify-between text-[11px] font-mono text-[#4B5563] shrink-0 tabular-nums">
            <span>
              {query ? `Matches for "${query}" (${results.length})` : 'Popular Global Hubs'}
            </span>
            <span className="hidden sm:inline">Use ↑↓ and Enter to select</span>
          </div>

          <div className="overflow-y-auto astris-scroll space-y-2 pr-1 flex-1 min-h-0">
            {results.length === 0 ? (
              <div className="py-12 text-center space-y-1.5">
                <p className="text-sm font-semibold text-[#111827]">
                  No airports matching "{query}"
                </p>
                <p className="text-xs text-[#4B5563]">
                  Try searching by 3-letter IATA code (e.g. HND, DXB, JFK) or major city name.
                </p>
              </div>
            ) : (
              results.map((hub, idx) => {
                const visits = visitCounts[hub.iataCode.toUpperCase()] ?? 0;
                const isHighlighted = idx === highlightedIndex;

                return (
                  <div
                    key={hub.id}
                    onClick={() => handleSelect(hub)}
                    onMouseEnter={() => setHighlightedIndex(idx)}
                    className={`flex items-center justify-between gap-3 p-3 rounded-xl border transition-all cursor-pointer ${
                      isHighlighted
                        ? 'bg-[#FFF4ED] border-[#FFD6BA] shadow-xs'
                        : 'bg-white border-neutral-200/80 hover:border-neutral-300'
                    }`}
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold px-2 py-0.5 rounded-md bg-[#FFF4ED] text-[#E56B1A] border border-[#FFD6BA] shrink-0 tabular-nums">
                          {hub.iataCode}
                        </span>
                        <span className="font-display font-semibold text-sm text-[#111827] truncate">
                          {hub.city}
                        </span>
                        <span className="text-xs text-[#4B5563] truncate">
                          · {hub.country}
                        </span>
                        {visits > 0 && (
                          <span className="shrink-0 rounded-md bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-[#4B5563] tabular-nums">
                            In trip{visits > 1 ? ` ×${visits}` : ''}
                          </span>
                        )}
                      </div>

                      <div className="text-xs text-[#4B5563] truncate">
                        {hub.tagline || `${hub.city} International Airport`}
                      </div>

                      <div className="text-[11px] font-mono text-[#4B5563] tabular-nums">
                        {hub.region} · {hub.lat.toFixed(2)}, {hub.lng.toFixed(2)} · {hub.recommendedNights}n stay
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSelect(hub);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold shrink-0 transition-colors cursor-pointer bg-[#FF812E] hover:bg-[#E56B1A] text-white shadow-xs"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>{visits > 0 ? 'Add Again' : 'Add Stop'}</span>
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
