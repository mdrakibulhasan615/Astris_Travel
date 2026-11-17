import { useState } from 'react';
import { BedDouble, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { formatShortDate } from '../../shared/dateUtils.ts';
import type { StayLink, StaySearch } from '../../shared/types.ts';
import { LiveHotels } from './HotelCards.tsx';

interface StayPanelProps {
  search: StaySearch;
  defaultExpanded?: boolean;
  /** Indent under the stop card and draw the timeline rail, like the transit panels. */
  inTimeline?: boolean;
}

/** Direct link to the partner's results for this city, dates and party. */
function PartnerLink({
  link,
  label,
  primary,
}: {
  link: StayLink;
  label: string;
  primary: boolean;
}) {
  return (
    <a
      href={link.url}
      target="_blank"
      rel="sponsored noopener noreferrer"
      title={`Opens ${link.providerName} with this city, dates and guests filled in`}
      onClick={() => {
        if (import.meta.env.DEV) console.debug('[Stays] opening', link.provider, link.url);
      }}
      className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E] focus-visible:ring-offset-1 ${
        primary
          ? 'bg-[#FF812E] text-white hover:bg-[#E56B1A]'
          : 'border border-neutral-200 bg-white text-[#111827] hover:border-[#FFD6BA] hover:bg-[#FFF4ED]'
      }`}
    >
      {label}
      <ExternalLink className="h-3 w-3" aria-hidden="true" />
    </a>
  );
}

/**
 * "Staying in [City]?" for one stop: live hotels with filters (when live data is on) and searches on
 * Booking.com / Agoda with this city, these dates and this party already filled in. Nothing here is
 * an estimated price.
 */
export function StayPanel({ search, defaultExpanded = false, inTimeline = false }: StayPanelProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div
      id={inTimeline ? undefined : `stays-${search.stopId}`}
      className={inTimeline ? 'relative my-1.5 pl-6' : 'scroll-mt-4'}
    >
      {inTimeline && (
        <div aria-hidden="true" className="absolute bottom-0 left-[15px] top-0 w-0.5 bg-neutral-200" />
      )}

      <div className="rounded-2xl border border-[#FFE3CC] bg-[#FFF6EE] shadow-sm transition-all hover:shadow-md">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
          className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-2xl px-4 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E]"
        >
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl border border-[#FFD6BA] bg-[#FFF4ED]">
              <BedDouble className="h-3.5 w-3.5 text-[#FF812E]" />
            </span>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-[#111827]">
                Staying in {search.city}?{' '}
                <span className="font-normal text-[#4B5563]">
                  Find and compare places to stay
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[#4B5563] tabular-nums">
                <span>
                  {formatShortDate(search.checkIn)} → {formatShortDate(search.checkOut)}
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {search.nights} night{search.nights === 1 ? '' : 's'}
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {search.adults} guest{search.adults === 1 ? '' : 's'}
                </span>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-[#4B5563]">
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </div>
        </button>

        {!expanded && search.links.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5 px-3.5 pb-2.5">
            {search.links.map((link, idx) => (
              <PartnerLink
                key={link.provider}
                link={link}
                label={`Compare on ${link.providerName}`}
                primary={idx === 0}
              />
            ))}
          </div>
        )}

        {expanded && (
          <div className="space-y-2 border-t border-neutral-100 px-3.5 pb-3.5 pt-2.5">
            <LiveHotels search={search} />
            {search.links.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <span className="text-[11px] text-[#4B5563]">
                  All stays in {search.city} for these dates
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {search.links.map((link) => (
                    <PartnerLink
                      key={link.provider}
                      link={link}
                      label={link.providerName}
                      primary={false}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
