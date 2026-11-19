import type { ReactNode } from 'react';
import { Compass, Sparkles } from 'lucide-react';
import { CURRENCIES, isCurrencyCode } from '../../shared/currency.ts';
import { useCurrency } from '../currency.tsx';

interface TopBarProps {
  /** The logo takes you back to the itinerary. */
  onGoHome: () => void;
  onOptimizeRoute: () => void;
  isOptimizing: boolean;
  /** Where tickets come from: set in code / environment, shown here for information only. */
  dataMode?: 'live' | 'mock';
  /** Route sync link + log in / profile: always the right-most thing on the bar. */
  accountSlot?: ReactNode;
}

export function TopBar({ onGoHome, onOptimizeRoute, isOptimizing, dataMode, accountSlot }: TopBarProps) {
  const { currency, setCurrency, rates } = useCurrency();
  return (
    <header className="h-16 glass-chrome relative px-5 lg:px-7 flex items-center justify-between gap-8 shrink-0 z-30">
      {/* Left: single-line brand wordmark */}
      <a
        href="#top"
        onClick={(e) => {
          e.preventDefault();
          onGoHome();
        }}
        className="flex items-center gap-2.5 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E] rounded-lg"
      >
        <span className="w-8 h-8 rounded-xl bg-[#FF812E] text-white flex items-center justify-center shadow-sm">
          <Compass className="w-4.5 h-4.5" strokeWidth={2.25} />
        </span>
        <span className="font-display text-lg font-bold tracking-tight text-[#111827] whitespace-nowrap">
          Astris Travel
        </span>
      </a>

      {/* Right: data mode, currency, the primary action, then the account controls last */}
      <div className="flex items-center gap-3 shrink-0">
        {dataMode && (
          <span
            title={
              dataMode === 'live'
                ? 'Live fares are on: press Fetch Live Fares on a leg'
                : 'Live fares are off: no SerpApi searches are made. Set USE_REAL_DATA=true to turn them on.'
            }
            className={`hidden lg:inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap ${
              dataMode === 'live'
                ? 'border-[#BBF7D0] bg-[#F0FDF4] text-[#15803D]'
                : 'border-[#FFD6BA] bg-[#FFF4ED] text-[#E56B1A]'
            }`}
          >
            {dataMode === 'live' ? 'Live fares' : 'Live fares off'}
          </span>
        )}

        <div className="relative">
          <label htmlFor="currency-select" className="sr-only">
            Display currency
          </label>
          <select
            id="currency-select"
            value={currency}
            onChange={(e) => isCurrencyCode(e.target.value) && setCurrency(e.target.value)}
            title={`Prices are shown in ${currency}. Exchange rates ${
              rates.source === 'live' ? '(ECB reference)' : '(approximate)'
            } as of ${rates.asOf}.`}
            className="h-9 cursor-pointer rounded-xl glass-control px-2.5 text-sm font-semibold text-[#111827] hover:border-[#FFD6BA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E]"
          >
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} · {c.name}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={onOptimizeRoute}
          disabled={isOptimizing}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#FF812E] hover:bg-[#E56B1A] active:scale-[0.99] disabled:opacity-60 text-white text-sm font-semibold shadow-sm transition-all whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E] focus-visible:ring-offset-2"
        >
          <Sparkles className="w-4 h-4" />
          <span>{isOptimizing ? 'Optimizing...' : 'Optimize Route'}</span>
        </button>

        {accountSlot}
      </div>
    </header>
  );
}
