import { useState } from 'react';
import { BedDouble, Check, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { formatShortDate } from '../../shared/dateUtils.ts';
import type { StayLink, StayOption, StaySearch } from '../../shared/types.ts';
import { SmartScoreBadge } from './SmartScoreBadge.tsx';

interface StayPanelProps {
  search: StaySearch;
  selectedOptionId?: string;
  defaultExpanded?: boolean;
  /** Indent under the stop card and draw the timeline rail, like the transit panels. */
  inTimeline?: boolean;
  onSelectOption: (stopId: string, optionId: string) => void;
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

function StayCard({
  option,
  rank,
  nights,
  isSelected,
  onSelect,
}: {
  option: StayOption;
  rank: number;
  nights: number;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <div data-stay-id={option.id} data-stay-score={option.smartScore}>
      <button
        type="button"
        onClick={onSelect}
        className={`w-full cursor-pointer rounded-xl border p-3 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E] ${
          isSelected
            ? 'border-[#FFD6BA] bg-[#FFF4ED]'
            : 'border-neutral-200/80 bg-white hover:border-neutral-300'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-x-2">
              <BedDouble className="h-3.5 w-3.5 shrink-0 text-[#FF812E]" />
              <span className="text-xs font-semibold text-[#111827]">{option.title}</span>
              {rank === 0 && (
                <span className="text-[11px] font-semibold text-[#E56B1A]">· #1 Rank</span>
              )}
            </div>
            <div className="text-[11px] text-[#4B5563]">
              {option.description} · about {option.commuteMinutesOneWay} min to the centre
            </div>
            <div className="font-mono text-[11px] text-[#4B5563] tabular-nums">
              ~${option.nightlyPriceUsd}/night × {nights} night{nights === 1 ? '' : 's'}
            </div>
          </div>

          <div className="shrink-0 space-y-0.5 text-right">
            <div className="font-display text-sm font-bold text-[#111827] tabular-nums">
              ~${option.totalPriceUsd.toFixed(0)}
            </div>
            <div>
              <SmartScoreBadge score={option.smartScore} />
            </div>
            {isSelected && (
              <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#E56B1A]">
                <Check className="h-3 w-3" />
                <span>Selected</span>
              </div>
            )}
          </div>
        </div>
      </button>

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 px-1">
        <span
          title="Typical price for this kind of stay in this city, not a quoted rate"
          className="rounded-md bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-[#4B5563]"
        >
          Estimate
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          {option.links.map((link, idx) => (
            <PartnerLink
              key={link.provider}
              link={link}
              label={`Find on ${link.providerName}`}
              primary={idx === 0}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * "Staying in [City]?" Ranked places to stay for one stop, each scored with the same VTTS Smart
 * Score as the transport options and linked straight to Booking.com / Agoda.
 */
export function StayPanel({
  search,
  selectedOptionId,
  defaultExpanded = false,
  inTimeline = false,
  onSelectOption,
}: StayPanelProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const selected =
    search.options.find((o) => o.id === selectedOptionId) ?? search.options[0];

  return (
    <div
      id={inTimeline ? undefined : `stays-${search.stopId}`}
      className={inTimeline ? 'relative my-1.5 pl-6' : 'scroll-mt-4'}
    >
      {inTimeline && (
        <div aria-hidden="true" className="absolute bottom-0 left-[15px] top-0 w-0.5 bg-neutral-200" />
      )}

      <div className="rounded-2xl border border-neutral-200/80 bg-white shadow-sm transition-all hover:shadow-md">
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
                {selected && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-medium text-[#111827]">{selected.title}</span>
                    <span className="font-mono font-semibold text-[#111827]">
                      ~${selected.totalPriceUsd.toFixed(0)}
                    </span>
                    <SmartScoreBadge score={selected.smartScore} size="sm" />
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-[#4B5563]">
            <span className="font-mono tabular-nums">{search.options.length}</span>
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
            {search.options.map((option, idx) => (
              <StayCard
                key={option.id}
                option={option}
                rank={idx}
                nights={search.nights}
                isSelected={option.id === selected?.id}
                onSelect={() => onSelectOption(search.stopId, option.id)}
              />
            ))}
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
