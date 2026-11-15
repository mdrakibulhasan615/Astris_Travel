import { BedDouble, Compass, Plus, Sparkles, Ticket } from 'lucide-react';
import { CURRENCIES, isCurrencyCode } from '../../shared/currency.ts';
import { useCurrency } from '../currency.tsx';

interface TopBarProps {
  activePanel: 'timeline' | 'stays' | 'smart-score' | 'vouchers';
  onSelectPanel: (panel: 'timeline' | 'stays' | 'smart-score' | 'vouchers') => void;
  onOpenAddStop: () => void;
  onOpenVouchers: () => void;
  onOptimizeRoute: () => void;
  isOptimizing: boolean;
  activeVoucherCount: number;
  /** Where tickets come from: set in code / environment, shown here for information only. */
  dataMode?: 'live' | 'mock';
}

export function TopBar({
  activePanel,
  onSelectPanel,
  onOpenAddStop,
  onOpenVouchers,
  onOptimizeRoute,
  isOptimizing,
  activeVoucherCount,
  dataMode,
}: TopBarProps) {
  const { currency, setCurrency, rates } = useCurrency();
  return (
    <header className="h-16 bg-white border-b border-neutral-200/80 px-5 lg:px-7 flex items-center justify-between gap-8 shrink-0 z-30">
      {/* Zone 1: Single-line Brand Wordmark */}
      <a
        href="#top"
        onClick={(e) => {
          e.preventDefault();
          onSelectPanel('timeline');
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

      {/* Zone 2: Clean single-line text navigation links */}
      <nav
        aria-label="Primary workspace navigation"
        className="hidden md:flex items-center gap-7 text-sm font-medium text-[#4B5563]"
      >
        <button
          type="button"
          onClick={() => onSelectPanel('timeline')}
          className={`py-1.5 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
            activePanel === 'timeline'
              ? 'border-[#FF812E] text-[#111827] font-semibold'
              : 'border-transparent hover:text-[#111827]'
          }`}
        >
          Itinerary
        </button>
        <button
          type="button"
          onClick={() => onSelectPanel('stays')}
          className={`py-1.5 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer inline-flex items-center gap-1.5 ${
            activePanel === 'stays'
              ? 'border-[#FF812E] text-[#111827] font-semibold'
              : 'border-transparent hover:text-[#111827]'
          }`}
        >
          <BedDouble className="w-3.5 h-3.5 text-[#4B5563]" />
          <span>Stays</span>
        </button>
        <button
          type="button"
          onClick={() => onSelectPanel('smart-score')}
          className={`py-1.5 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
            activePanel === 'smart-score'
              ? 'border-[#FF812E] text-[#111827] font-semibold'
              : 'border-transparent hover:text-[#111827]'
          }`}
        >
          Smart Score
        </button>
        <button
          type="button"
          onClick={onOpenVouchers}
          className={`py-1.5 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer inline-flex items-center gap-1.5 ${
            activePanel === 'vouchers'
              ? 'border-[#FF812E] text-[#111827] font-semibold'
              : 'border-transparent hover:text-[#111827]'
          }`}
        >
          <Ticket className="w-3.5 h-3.5 text-[#4B5563]" />
          <span>Vouchers ({activeVoucherCount})</span>
        </button>
        <button
          type="button"
          onClick={onOpenAddStop}
          className="py-1.5 border-b-2 border-transparent hover:text-[#111827] transition-colors whitespace-nowrap shrink-0 cursor-pointer inline-flex items-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5 text-[#4B5563]" />
          <span>Add Stop</span>
        </button>
      </nav>

      {/* Zone 3: data mode, currency, single primary action */}
      <div className="flex items-center gap-3 shrink-0">
        {dataMode && (
          <span
            title={
              dataMode === 'live'
                ? 'Live Google Flights fares (SerpApi)'
                : 'Sample tickets: no SerpApi requests are made. Set USE_REAL_DATA=true for live fares.'
            }
            className={`hidden lg:inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap ${
              dataMode === 'live'
                ? 'border-[#BBF7D0] bg-[#F0FDF4] text-[#15803D]'
                : 'border-[#FFD6BA] bg-[#FFF4ED] text-[#E56B1A]'
            }`}
          >
            {dataMode === 'live' ? 'Live fares' : 'Sample data'}
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
            className="h-9 cursor-pointer rounded-xl border border-neutral-200 bg-white px-2.5 text-sm font-semibold text-[#111827] hover:border-[#FFD6BA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E]"
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
      </div>
    </header>
  );
}
