import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  BedDouble,
  Car,
  Coffee,
  Dumbbell,
  SlidersHorizontal,
  Snowflake,
  Sparkles,
  Star,
  Waves,
  Wifi,
} from 'lucide-react';
import { buildHotelBookingLinks } from '../../shared/affiliate.ts';
import type { HotelResult, StaySearch } from '../../shared/types.ts';
import { useCurrency } from '../currency.tsx';
import { useTicketMask } from '../useTicketMask.ts';
import { OffersButton, type OfferRow } from './BookingOffers.tsx';

interface HotelsResponse {
  enabled: boolean;
  hotels: HotelResult[];
  cached?: boolean;
}

// The amenities worth a badge or a filter. Google marks paid extras with "($)" ("Breakfast ($)"):
// only what is free or part of the stay counts, and badges use Google's own wording.
const KEY_AMENITIES = [
  { id: 'wifi', label: 'Wi-Fi', test: /wi-?fi/i, icon: <Wifi className="h-3 w-3" aria-hidden="true" /> },
  { id: 'breakfast', label: 'Breakfast', test: /breakfast/i, icon: <Coffee className="h-3 w-3" aria-hidden="true" /> },
  { id: 'pool', label: 'Pool', test: /pool/i, icon: <Waves className="h-3 w-3" aria-hidden="true" /> },
  { id: 'spa', label: 'Spa / hot tub', test: /spa|sauna|hot tub/i, icon: <Sparkles className="h-3 w-3" aria-hidden="true" /> },
  { id: 'gym', label: 'Gym', test: /fitness|gym/i, icon: <Dumbbell className="h-3 w-3" aria-hidden="true" /> },
  { id: 'ac', label: 'A/C', test: /air.?condition/i, icon: <Snowflake className="h-3 w-3" aria-hidden="true" /> },
  { id: 'parking', label: 'Parking', test: /parking/i, icon: <Car className="h-3 w-3" aria-hidden="true" /> },
] as const;

type AmenityId = (typeof KEY_AMENITIES)[number]['id'];

/** The free listing for a key amenity, or undefined when the property lacks it or charges for it. */
function freeAmenity(amenities: string[], key: (typeof KEY_AMENITIES)[number]): string | undefined {
  const hit = amenities.find((a) => key.test.test(a) && !/\(\$+\)/.test(a));
  if (!hit) return undefined;
  // "Breakfast" alone is ambiguous; Google lists "Free breakfast" when it is included
  if (key.id === 'breakfast' && !/free|included/i.test(hit)) return undefined;
  return hit.trim();
}

/** Up to four badges for the amenities the property offers at no extra charge. */
function amenityBadges(amenities: string[]): { label: string; icon: ReactNode }[] {
  const out: { label: string; icon: ReactNode }[] = [];
  for (const key of KEY_AMENITIES) {
    const hit = freeAmenity(amenities, key);
    if (hit) out.push({ label: hit, icon: key.icon });
    if (out.length === 4) break;
  }
  return out;
}

function HotelCard({ hotel, search }: { hotel: HotelResult; search: StaySearch }) {
  const { fmt } = useCurrency();
  const cardRef = useRef<HTMLDivElement>(null);
  const stubRef = useRef<HTMLDivElement>(null);
  useTicketMask(cardRef, stubRef);

  const badges = useMemo(() => amenityBadges(hotel.amenities), [hotel.amenities]);
  const rows = useMemo<OfferRow[]>(() => {
    const google: OfferRow = {
      key: 'google',
      name: hotel.link ? 'Hotel website · best rate found' : 'Google Hotels · best rate found',
      badge: 'google-hotels',
      priceUsd: hotel.totalUsd,
      url: hotel.link ?? `https://www.google.com/travel/search?q=${encodeURIComponent(`${hotel.name} ${search.city}`)}`,
      title: 'Opens the property or Google Hotels at the rate shown',
    };
    const others = buildHotelBookingLinks({
      city: search.city,
      country: search.country,
      checkIn: search.checkIn,
      checkOut: search.checkOut,
      adults: search.adults,
      rooms: search.rooms,
      property: hotel.name,
    }).map(
      (l): OfferRow => ({
        key: l.key,
        name: l.name,
        badge: l.badge,
        url: l.url,
        title: `Opens ${l.name} with these dates and guests filled in`,
      })
    );
    return [google, ...others];
  }, [hotel, search]);

  return (
    <div className="@container ticket-shape" data-selected="false">
      <div
        ref={cardRef}
        data-hotel-id={hotel.id}
        className="mask-bp relative overflow-hidden rounded-2xl bg-white"
      >
        <div className="relative @[28rem]:grid @[28rem]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          {/* Property */}
          <div className="flex min-w-0 gap-3 p-3">
            {hotel.thumbnailUrl ? (
              <img
                src={hotel.thumbnailUrl}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                className="h-24 w-24 shrink-0 rounded-xl bg-neutral-100 object-cover"
              />
            ) : (
              <span className="flex h-24 w-24 shrink-0 items-center justify-center rounded-xl bg-neutral-100 text-neutral-400">
                <BedDouble className="h-7 w-7" aria-hidden="true" />
              </span>
            )}
            <div className="min-w-0 space-y-1.5">
              <div className="font-display text-sm font-extrabold leading-tight text-[#111827]">{hotel.name}</div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[#4B5563]">
                {hotel.type && <span>{hotel.type}</span>}
                {hotel.stars && (
                  <span className="inline-flex items-center gap-0.5 text-[#B45309]" title={`${hotel.stars}-star`}>
                    {Array.from({ length: hotel.stars }, (_, i) => (
                      <Star key={i} className="h-3 w-3" fill="currentColor" aria-hidden="true" />
                    ))}
                  </span>
                )}
                {hotel.rating && (
                  <span className="inline-flex items-center gap-1 font-semibold text-[#111827]">
                    <span className="rounded bg-[#15803D] px-1 py-px font-mono text-[10px] text-white">{hotel.rating.toFixed(1)}</span>
                    {hotel.reviews ? (
                      <span className="font-normal text-[#4B5563]">({hotel.reviews.toLocaleString()} reviews)</span>
                    ) : null}
                  </span>
                )}
              </div>
              {badges.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {badges.map((b) => (
                    <span
                      key={b.label}
                      className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-px text-[10px] font-semibold text-[#374151]"
                    >
                      {b.icon}
                      {b.label}
                    </span>
                  ))}
                </div>
              )}
              {hotel.deal && <div className="text-[10px] font-semibold text-[#15803D]">{hotel.deal}</div>}
            </div>
          </div>

          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 left-[66.6667%] top-0 hidden border-l-[1.5px] border-dashed border-neutral-300 @[28rem]:block"
          />

          {/* Stub: price and booking */}
          <div
            ref={stubRef}
            className="flex flex-col justify-between gap-2 border-t-[1.5px] border-dashed border-neutral-300 px-3 pb-2.5 pt-2 @[28rem]:border-t-0"
          >
            <div>
              <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-[#6B7280]">Per night</div>
              <div className="whitespace-nowrap font-display text-lg font-extrabold leading-tight text-[#111827] tabular-nums">
                {fmt(hotel.nightlyUsd)}
              </div>
              <div className="font-mono text-[11px] text-[#4B5563] tabular-nums">
                {fmt(hotel.totalUsd)} · {hotel.nights} night{hotel.nights === 1 ? '' : 's'}
              </div>
            </div>
            <OffersButton
              id={`hotel-${hotel.id}`}
              label={`Booking options for ${hotel.name}`}
              rows={rows}
              footnote="The first price is Google Hotels' lowest rate for these dates. Other sites show their own price when you open them."
              cardRef={cardRef}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sorting and filtering ────────────────────────────────────────────────────────────────────────

type Sort = 'price' | 'price-desc' | 'rating' | 'reviews' | 'stars' | 'match';

interface Filters {
  /** Lowest guest score accepted (0 = any). Hotels without a score are hidden once this is set. */
  minRating: number;
  /** Lowest hotel class accepted (0 = any). */
  minStars: number;
  /** Highest nightly price accepted, or null for no limit. */
  maxNightlyUsd: number | null;
  amenities: AmenityId[];
  /** Property types to keep; empty = all. */
  types: string[];
  dealsOnly: boolean;
}

const NO_FILTERS: Filters = { minRating: 0, minStars: 0, maxNightlyUsd: null, amenities: [], types: [], dealsOnly: false };

function activeFilterCount(f: Filters): number {
  return (
    Number(f.minRating > 0) +
    Number(f.minStars > 0) +
    Number(f.maxNightlyUsd !== null) +
    f.amenities.length +
    Number(f.types.length > 0) +
    Number(f.dealsOnly)
  );
}

function applyFilters(hotels: HotelResult[], f: Filters): HotelResult[] {
  return hotels.filter((h) => {
    if (f.minRating > 0 && (h.rating ?? 0) < f.minRating) return false;
    if (f.minStars > 0 && (h.stars ?? 0) < f.minStars) return false;
    if (f.maxNightlyUsd !== null && h.nightlyUsd > f.maxNightlyUsd) return false;
    if (f.types.length > 0 && !f.types.includes(h.type ?? 'other')) return false;
    if (f.dealsOnly && !h.deal) return false;
    return f.amenities.every((id) => {
      const key = KEY_AMENITIES.find((k) => k.id === id);
      return key ? freeAmenity(h.amenities, key) !== undefined : true;
    });
  });
}

function sortHotels(hotels: HotelResult[], sort: Sort): HotelResult[] {
  const list = [...hotels];
  switch (sort) {
    case 'price':
      return list.sort((a, b) => a.totalUsd - b.totalUsd);
    case 'price-desc':
      return list.sort((a, b) => b.totalUsd - a.totalUsd);
    case 'rating':
      return list.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || a.totalUsd - b.totalUsd);
    case 'reviews':
      return list.sort((a, b) => (b.reviews ?? 0) - (a.reviews ?? 0));
    case 'stars':
      return list.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0) || a.totalUsd - b.totalUsd);
    default:
      return list;
  }
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`cursor-pointer rounded-full border px-2.5 py-0.5 text-[11px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E] ${
        active
          ? 'border-[#FFD6BA] bg-[#FFF4ED] text-[#C2410C]'
          : 'border-neutral-200 bg-white text-[#374151] hover:border-neutral-300'
      }`}
    >
      {children}
    </button>
  );
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]">{label}</div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

/**
 * Live hotels for one stop from Google Hotels, cheapest first by default, with filters for guest
 * rating, stars, price, amenities, property type and deals. Loads when the stop's stay card is
 * opened, and renders nothing unless the server is in live-data mode with a SerpApi key.
 */
export function LiveHotels({ search }: { search: StaySearch }) {
  const { fmt } = useCurrency();
  const [data, setData] = useState<HotelsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<Sort>('price');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFilters(NO_FILTERS);
    const params = new URLSearchParams({
      city: search.city,
      country: search.country ?? '',
      checkIn: search.checkIn,
      checkOut: search.checkOut,
      adults: String(search.adults),
    });
    fetch(`/api/hotels/search?${params.toString()}`)
      .then((res) => (res.ok ? (res.json() as Promise<HotelsResponse>) : null))
      .then((body) => {
        if (active) setData(body);
      })
      .catch(() => {
        // the section simply stays hidden
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [search.city, search.country, search.checkIn, search.checkOut, search.adults]);

  const all = data?.hotels ?? [];
  const shown = useMemo(() => sortHotels(applyFilters(all, filters), sort), [all, filters, sort]);

  // What the data offers decides which filter choices appear
  const priceBounds = useMemo(() => {
    const prices = all.map((h) => h.nightlyUsd);
    return prices.length ? { min: Math.floor(Math.min(...prices)), max: Math.ceil(Math.max(...prices)) } : null;
  }, [all]);
  const types = useMemo(() => [...new Set(all.map((h) => h.type ?? 'other'))], [all]);
  const hasDeals = all.some((h) => h.deal);
  const offeredAmenities = useMemo(
    () => KEY_AMENITIES.filter((k) => all.some((h) => freeAmenity(h.amenities, k) !== undefined)),
    [all]
  );

  if (!data?.enabled) return null;

  const count = activeFilterCount(filters);
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  return (
    <section aria-label={`Live hotels in ${search.city}`} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-[#4B5563]">
          Live hotels
          <span className="ml-2 rounded-md bg-[#F0FDF4] px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-[#15803D]">
            Google Hotels
          </span>
        </div>
        {all.length > 1 && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-expanded={showFilters}
              onClick={() => setShowFilters((v) => !v)}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-[#111827] hover:border-neutral-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E]"
            >
              <SlidersHorizontal className="h-3 w-3" aria-hidden="true" />
              Filters
              {count > 0 && (
                <span className="rounded-full bg-[#FF812E] px-1.5 text-[10px] font-bold text-white">{count}</span>
              )}
            </button>
            <label className="flex items-center gap-1.5 text-[11px] text-[#4B5563]">
              Sort
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
                className="rounded-md border border-neutral-200 bg-white px-1.5 py-0.5 text-[11px] text-[#111827]"
              >
                <option value="price">Lowest price</option>
                <option value="price-desc">Highest price</option>
                <option value="rating">Top rated</option>
                <option value="reviews">Most reviewed</option>
                <option value="stars">Star class</option>
                <option value="match">Best match</option>
              </select>
            </label>
          </div>
        )}
      </div>

      {showFilters && all.length > 1 && (
        <div className="space-y-3 rounded-xl border border-neutral-200/80 bg-white p-3">
          <FilterGroup label="Guest rating">
            {[0, 3.5, 4, 4.5].map((r) => (
              <Chip key={r} active={filters.minRating === r} onClick={() => set({ minRating: r })}>
                {r === 0 ? 'Any' : `${r}+`}
              </Chip>
            ))}
          </FilterGroup>
          <FilterGroup label="Stars">
            {[0, 3, 4, 5].map((s) => (
              <Chip key={s} active={filters.minStars === s} onClick={() => set({ minStars: s })}>
                {s === 0 ? 'Any' : s === 5 ? '5★' : `${s}★+`}
              </Chip>
            ))}
          </FilterGroup>
          {priceBounds && priceBounds.max > priceBounds.min && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]">
                <span>Max price per night</span>
                <span className="font-mono text-[11px] normal-case tracking-normal text-[#111827]">
                  {filters.maxNightlyUsd === null ? 'No limit' : fmt(filters.maxNightlyUsd)}
                </span>
              </div>
              <input
                type="range"
                min={priceBounds.min}
                max={priceBounds.max}
                step={Math.max(1, Math.round((priceBounds.max - priceBounds.min) / 40))}
                value={filters.maxNightlyUsd ?? priceBounds.max}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  set({ maxNightlyUsd: v >= priceBounds.max ? null : v });
                }}
                aria-label="Maximum price per night"
                className="w-full accent-[#FF812E]"
              />
            </div>
          )}
          {offeredAmenities.length > 0 && (
            <FilterGroup label="Included amenities">
              {offeredAmenities.map((k) => (
                <Chip
                  key={k.id}
                  active={filters.amenities.includes(k.id)}
                  onClick={() => set({ amenities: toggle(filters.amenities, k.id) })}
                >
                  {k.label}
                </Chip>
              ))}
            </FilterGroup>
          )}
          {types.length > 1 && (
            <FilterGroup label="Property type">
              {types.map((t) => (
                <Chip key={t} active={filters.types.includes(t)} onClick={() => set({ types: toggle(filters.types, t) })}>
                  {t[0].toUpperCase() + t.slice(1)}
                </Chip>
              ))}
            </FilterGroup>
          )}
          {hasDeals && (
            <FilterGroup label="Deals">
              <Chip active={filters.dealsOnly} onClick={() => set({ dealsOnly: !filters.dealsOnly })}>
                Deals only
              </Chip>
            </FilterGroup>
          )}
          <div className="flex items-center justify-between text-[11px] text-[#4B5563]">
            <span>
              Showing {shown.length} of {all.length}
            </span>
            {count > 0 && (
              <button
                type="button"
                onClick={() => setFilters(NO_FILTERS)}
                className="cursor-pointer font-semibold text-[#C2410C] underline underline-offset-2"
              >
                Reset filters
              </button>
            )}
          </div>
        </div>
      )}

      {loading && all.length === 0 && <div className="text-[11px] text-[#4B5563]">Loading hotels…</div>}
      {!loading && all.length === 0 && (
        <div className="text-[11px] text-[#4B5563]">No live prices found for these dates.</div>
      )}
      {all.length > 0 && shown.length === 0 && (
        <div className="rounded-xl border border-dashed border-neutral-300 p-3 text-center text-[11px] text-[#4B5563]">
          No hotels match these filters.{' '}
          <button
            type="button"
            onClick={() => setFilters(NO_FILTERS)}
            className="cursor-pointer font-semibold text-[#C2410C] underline underline-offset-2"
          >
            Reset filters
          </button>
        </div>
      )}
      <div className="space-y-2.5">
        {shown.map((h) => (
          <HotelCard key={h.id} hotel={h} search={search} />
        ))}
      </div>
    </section>
  );
}
