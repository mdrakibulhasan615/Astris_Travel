import { ExternalLink, Loader2, RefreshCw, Zap } from 'lucide-react';
import type { LiveFareEntry, LiveFareStatus } from '../liveFares.ts';

/**
 * The per-leg "Fetch Live Fares" control. Live fares are never fetched on their own: each press can
 * spend one of the free monthly SerpApi searches (a repeat within 30 minutes is served from the
 * cache and costs nothing), so the traveller chooses which corridors are worth it.
 */
export function LiveFaresBar({
  entry,
  status,
  hasLiveFares,
  hasAnyFares,
  onFetch,
}: {
  entry?: LiveFareEntry;
  status?: LiveFareStatus;
  /** The card list is currently showing this entry's live fares. */
  hasLiveFares: boolean;
  /** The leg lists some fare (live, or a recent fare), so "no fares" would be wrong to say. */
  hasAnyFares: boolean;
  onFetch: () => void;
}) {
  const loading = Boolean(status?.loading);
  const offline = entry?.mode === 'offline';
  const time = entry
    ? new Date(entry.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;

  return (
    <div className="space-y-1.5 px-3.5 pb-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onFetch}
          disabled={loading}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#FF812E] bg-white px-2.5 py-1 text-[11px] font-bold text-[#C2410C] hover:bg-[#FFF4ED] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E] focus-visible:ring-offset-1 disabled:cursor-default disabled:opacity-60"
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : hasLiveFares ? (
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
          ) : (
            <Zap className="h-3 w-3" aria-hidden="true" />
          )}
          {loading ? 'Fetching live fares…' : hasLiveFares ? 'Refresh live fares' : 'Fetch Live Fares'}
        </button>
        {hasLiveFares && time && (
          <span className="text-[11px] text-[#4B5563]">
            Live fares as of {time}
            {entry?.cached ? ' (saved result, no search used)' : ''}
          </span>
        )}
        {!entry && !loading && !status?.error && (
          <span className="text-[11px] text-[#6B7280]">{hasAnyFares ? 'Recent fares shown. Live prices are fetched on request.' : 'No fares yet. Live prices are fetched on request.'}</span>
        )}
      </div>

      {loading && (
        <div aria-busy="true" aria-label="Loading live fares" className="space-y-1.5 pt-0.5">
          {[0, 1].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded-lg bg-neutral-100" />
          ))}
        </div>
      )}

      {status?.error && !loading && (
        <p role="alert" className="text-[11px] text-red-600">
          {status.error}
        </p>
      )}

      {entry && entry.mode === 'live' && entry.options.length === 0 && !loading && (
        <p className="text-[11px] text-[#4B5563]">No live flights were found for this date.</p>
      )}

      {offline && !loading && (
        <div role="status" className="rounded-lg border border-neutral-200 bg-neutral-50 p-2 text-[11px] text-[#374151]">
          <p className="font-semibold">
            {entry?.reason === 'QUOTA_EXCEEDED'
              ? 'The free live-fare allowance is used up for now.'
              : entry?.reason === 'NO_KEY'
                ? 'Live fares are not set up on this server.'
                : 'Live fares are switched off.'}{' '}
            <span className="font-normal">Search this exact route instead:</span>
          </p>
          {entry && entry.fallbackLinks.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {entry.fallbackLinks.map((l) => (
                <a
                  key={l.name}
                  href={l.url}
                  target="_blank"
                  rel="sponsored noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-1 font-bold text-[#111827] ring-1 ring-neutral-300 hover:bg-neutral-100"
                >
                  {l.name}
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
