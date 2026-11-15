import { ArrowRight, CheckCircle2, Route, Sparkles, X } from 'lucide-react';
import type { RouteOptimizationResult } from '../../shared/types.ts';
import { useCurrency } from '../currency.tsx';

interface RouteOptimizerModalProps {
  isOpen: boolean;
  isLoading: boolean;
  result: RouteOptimizationResult | null;
  onClose: () => void;
  onApplyOptimized: (result: RouteOptimizationResult) => void;
}

export function RouteOptimizerModal({
  isOpen,
  isLoading,
  result,
  onClose,
  onApplyOptimized,
}: RouteOptimizerModalProps) {
  const { fmt } = useCurrency();
  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Two-Stage Global Route Optimizer"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/35 backdrop-blur-xs"
    >
      <div className="w-full max-w-2xl rounded-2xl bg-white border border-neutral-200 shadow-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-neutral-100 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-xl bg-[#FFF4ED] border border-[#FFD6BA] text-[#E56B1A] flex items-center justify-center">
              <Route className="w-4 h-4" />
            </span>
            <h2 className="font-display text-lg font-bold text-[#111827]">
              Route Optimizer
            </h2>
          </div>

          <button
            type="button"
            aria-label="Close optimizer"
            onClick={onClose}
            className="w-8 h-8 rounded-xl flex items-center justify-center text-[#4B5563] hover:text-[#111827] hover:bg-neutral-100 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {isLoading ? (
            <div className="space-y-3 py-6">
              <div className="h-5 w-2/3 rounded-lg bg-neutral-100 animate-pulse" />
              <div className="h-20 w-full rounded-xl bg-neutral-100 animate-pulse" />
              <div className="h-20 w-full rounded-xl bg-neutral-100 animate-pulse" />
            </div>
          ) : result ? (
            <>
              <div
                className={`rounded-xl p-4 border ${
                  result.alreadyOptimal
                    ? 'bg-emerald-50/60 border-emerald-200'
                    : 'bg-[#FFF4ED] border-[#FFD6BA]'
                }`}
              >
                <div className="flex items-start gap-2.5">
                  <CheckCircle2
                    className={`w-5 h-5 shrink-0 mt-0.5 ${
                      result.alreadyOptimal ? 'text-[#16A34A]' : 'text-[#E56B1A]'
                    }`}
                  />
                  <div>
                    <div className="text-sm font-semibold text-[#111827]">
                      {result.alreadyOptimal
                        ? 'Optimal Corridor Sequence Confirmed'
                        : 'More Efficient Stop Sequence Found'}
                    </div>
                    <p className="mt-0.5 text-xs text-[#4B5563]">{result.summaryMessage}</p>
                  </div>
                </div>
              </div>

              {/* Before vs Optimized Comparison */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="rounded-xl border border-neutral-200/80 p-3.5">
                  <div className="text-xs text-[#4B5563]">Distance Delta</div>
                  <div className="mt-1 font-display text-lg font-bold text-[#111827] tabular-nums">
                    {result.optimizedDistanceKm.toLocaleString()} km
                  </div>
                  <div className="text-xs text-[#16A34A] font-mono tabular-nums">
                    {result.distanceSavedKm > 0
                      ? `-${result.distanceSavedKm.toLocaleString()} km saved`
                      : `Same as current (${result.originalDistanceKm.toLocaleString()} km)`}
                  </div>
                </div>

                <div className="rounded-xl border border-neutral-200/80 p-3.5">
                  <div className="text-xs text-[#4B5563]">Optimized Transit Fare</div>
                  <div className="mt-1 font-display text-lg font-bold text-[#111827] tabular-nums">
                    {fmt(result.optimizedCostUsd)}
                  </div>
                  <div className="text-xs text-[#4B5563] font-mono tabular-nums">
                    Current: {fmt(result.originalCostUsd)}
                  </div>
                </div>

                <div className="rounded-xl border border-neutral-200/80 p-3.5">
                  <div className="text-xs text-[#4B5563]">Weighted Smart Score</div>
                  <div className="mt-1 font-display text-lg font-bold text-[#E56B1A] tabular-nums">
                    {result.optimizedSmartScore.toFixed(0)}
                  </div>
                  <div className="text-xs text-[#4B5563] font-mono tabular-nums">
                    Current: {result.originalSmartScore.toFixed(0)}
                  </div>
                </div>
              </div>

              {/* Stage 2 Top Candidates Table */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-semibold text-[#111827]">
                    Top Stage 2 Evaluated Paths ({result.candidatesEvaluated} permutations screened)
                  </h3>
                </div>
                <div className="space-y-2 max-h-52 overflow-y-auto astris-scroll pr-1">
                  {result.topCandidates.map((cand, idx) => (
                    <div
                      key={cand.stopIds.join('-')}
                      className={`p-3 rounded-xl border flex flex-wrap items-center justify-between gap-2 text-xs ${
                        idx === 0
                          ? 'bg-[#FFF4ED] border-[#FFD6BA]'
                          : 'bg-white border-neutral-200/80'
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-1.5 font-medium text-[#111827]">
                        <span className="font-mono text-[#E56B1A]">#{idx + 1}</span>
                        {cand.routeLabels.map((label, i) => (
                          <span key={label} className="inline-flex items-center gap-1">
                            <span>{label}</span>
                            {i < cand.routeLabels.length - 1 && (
                              <ArrowRight className="w-3 h-3 text-neutral-400" />
                            )}
                          </span>
                        ))}
                      </div>
                      <div className="flex items-center gap-3 font-mono text-[#4B5563] tabular-nums">
                        <span>{cand.totalDistanceKm.toLocaleString()} km</span>
                        <span>{cand.estimatedTotalHours.toFixed(1)}h</span>
                        <span>{fmt(cand.estimatedTotalCostUsd)}</span>
                        <span className="font-semibold text-[#111827]">
                          Score: {cand.totalSmartScore.toFixed(0)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <p role="alert" className="py-6 text-center text-sm text-[#4B5563]">
              The route optimizer couldn't complete. Your current itinerary is unchanged; please try again.
            </p>
          )}
        </div>

        <div className="px-6 py-4 bg-[#FAFAFA] border-t border-neutral-100 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-medium text-[#4B5563] hover:text-[#111827] hover:bg-neutral-200/60 transition-colors cursor-pointer"
          >
            Close
          </button>
          {result && !result.alreadyOptimal && (
            <button
              type="button"
              onClick={() => {
                onApplyOptimized(result);
                onClose();
              }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#FF812E] hover:bg-[#E56B1A] text-white text-sm font-semibold shadow-sm transition-colors cursor-pointer"
            >
              <Sparkles className="w-4 h-4" />
              <span>Apply Optimized Sequence</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
