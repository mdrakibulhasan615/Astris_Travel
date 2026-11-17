import { useState } from 'react';
import { ChevronDown, ChevronUp, SlidersHorizontal } from 'lucide-react';
import {
  hourlyRateToPacingPercent,
  pacingPercentToHourlyRate,
  VTTS_PRESETS,
} from '../../shared/smartScore.ts';
import type { VttsTier } from '../../shared/types.ts';
import { useCurrency } from '../currency.tsx';

interface VttsControlPanelProps {
  vttsTier: VttsTier;
  hourlyTimeValue: number;
  totalCostUsd: number;
  totalHours: number;
  totalSmartScore: number;
  totalDistanceKm: number;
  onSelectPreset: (tier: Exclude<VttsTier, 'custom'>, hourlyRateUsd: number) => void;
  onChangeCustomRate: (hourlyRateUsd: number) => void;
}

export function VttsControlPanel({
  vttsTier,
  hourlyTimeValue,
  totalCostUsd,
  totalHours,
  totalSmartScore,
  totalDistanceKm,
  onSelectPreset,
  onChangeCustomRate,
}: VttsControlPanelProps) {
  const { fmt } = useCurrency();
  const [showAdvancedSlider, setShowAdvancedSlider] = useState(false);

  const currentPercent =
    vttsTier === 'backpacker'
      ? 0
      : vttsTier === 'explorer'
        ? 50
        : vttsTier === 'express'
          ? 100
          : hourlyRateToPacingPercent(hourlyTimeValue);

  const handleSelectPreset = (presetId: Exclude<VttsTier, 'custom'>) => {
    const preset = VTTS_PRESETS.find((p) => p.id === presetId);
    if (preset) {
      onSelectPreset(preset.id, preset.hourlyRateUsd);
    }
  };

  const handleSliderChange = (newPercent: number) => {
    const val = Math.max(0, Math.min(100, Math.round(newPercent)));
    if (val === 0) {
      onSelectPreset('backpacker', 5);
    } else if (val === 50) {
      onSelectPreset('explorer', 15);
    } else if (val === 100) {
      onSelectPreset('express', 35);
    } else {
      onChangeCustomRate(pacingPercentToHourlyRate(val));
    }
  };

  return (
    <section
      aria-label="Trip summary and travel pacing controls"
      className="bg-white rounded-2xl border border-neutral-200/80 shadow-sm p-4 space-y-3.5"
    >
      {/* Compact tabular KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pb-3.5 border-b border-neutral-100">
        <div>
          <div className="text-[11px] font-medium text-[#4B5563]">Total Fare</div>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className="font-display text-lg font-bold text-[#111827] tabular-nums">
              {totalCostUsd > 0 ? fmt(totalCostUsd) : '–'}
            </span>
          </div>
        </div>

        <div>
          <div className="text-[11px] font-medium text-[#4B5563]">Transit Time</div>
          <div className="mt-0.5 font-display text-lg font-bold text-[#111827] tabular-nums">
            {totalHours.toFixed(1)}h
          </div>
        </div>

        <div>
          <div className="text-[11px] font-medium text-[#4B5563]">Smart Score</div>
          <div className="mt-0.5 font-display text-lg font-bold text-[#E56B1A] tabular-nums">
            {totalSmartScore.toFixed(0)}
          </div>
        </div>

        <div>
          <div className="text-[11px] font-medium text-[#4B5563]">Distance</div>
          <div className="mt-0.5 font-display text-lg font-bold text-[#111827] tabular-nums">
            {totalDistanceKm.toLocaleString()} km
          </div>
        </div>
      </div>

      {/* Travel Pacing Controls */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-xs font-semibold text-[#111827]">
            Travel Pacing
          </h2>

          <button
            type="button"
            onClick={() => setShowAdvancedSlider((prev) => !prev)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-[#4B5563] hover:text-[#111827] px-2 py-1 rounded-lg hover:bg-neutral-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <SlidersHorizontal className="w-3.5 h-3.5 text-[#FF812E]" />
            <span className="font-mono tabular-nums font-semibold text-[#111827]">
              {currentPercent}%
            </span>
            {showAdvancedSlider ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </button>
        </div>

        <div
          role="radiogroup"
          aria-label="Travel pacing style preset"
          className="grid grid-cols-3 gap-1.5 p-1 bg-neutral-100 rounded-xl"
        >
          {VTTS_PRESETS.map((preset) => {
            const isActive = vttsTier === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={isActive}
                onClick={() => handleSelectPreset(preset.id)}
                className={`px-3 py-2.5 rounded-lg flex items-center justify-center text-center transition-all cursor-pointer ${
                  isActive
                    ? 'bg-[#FFF4ED] border border-[#FFD6BA] shadow-sm text-[#111827] font-bold'
                    : 'border border-transparent text-[#4B5563] hover:text-[#111827] hover:bg-white/60 font-medium'
                }`}
              >
                <span className="text-xs truncate">{preset.label}</span>
              </button>
            );
          })}
        </div>

        {showAdvancedSlider && (
          <div className="pt-2 space-y-2 border-t border-neutral-100">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="travel-pacing-slider" className="font-medium text-[#111827]">
                Custom Pacing
              </label>
              <span className="font-mono font-semibold text-[#E56B1A] tabular-nums">
                {currentPercent}%
              </span>
            </div>

            {/* Inset slider wrapper so 0% and 100% anchor rings never clip */}
            <div className="px-2 space-y-1">
              {/* Slider track with Sunset Orange fill and translucent anchor indicator rings */}
              <div className="relative w-full flex items-center h-6 select-none">
                {/* Background track */}
                <div className="absolute inset-x-0 h-2 bg-neutral-200/90 rounded-full overflow-hidden">
                  {/* Active fill with primary Sunset Orange */}
                  <div
                    className="h-full bg-[#FF812E] rounded-full pointer-events-none transition-[width] duration-75"
                    style={{ width: `${currentPercent}%` }}
                  />
                </div>

                {/* Translucent preset anchor circles layered underneath range input */}
                {/* 0% (Budget Backpacker anchor - aligned to absolute left edge of track line) */}
                <div
                  className="absolute left-0 top-1/2 -translate-y-1/2 translate-x-0 w-4 h-4 rounded-full border-2 border-white/95 bg-[#FF812E]/40 pointer-events-none z-10 shadow-xs"
                  title="Budget Backpacker (0%)"
                />
                {/* 50% (Balanced Explorer anchor - aligned to exact center) */}
                <div
                  className="absolute left-1/2 top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full border-2 border-white/95 bg-[#FF812E]/40 pointer-events-none z-10 shadow-xs"
                  title="Balanced Explorer (50%)"
                />
                {/* 100% (Express anchor - aligned to absolute right edge of track line) */}
                <div
                  className="absolute left-full top-1/2 -translate-y-1/2 -translate-x-full w-4 h-4 rounded-full border-2 border-white/95 bg-[#FF812E]/40 pointer-events-none z-10 shadow-xs"
                  title="Express (100%)"
                />

                {/* Native range input layered on top */}
                <input
                  id="travel-pacing-slider"
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={currentPercent}
                  onChange={(e) => handleSliderChange(Number(e.target.value))}
                  className="relative z-20 w-full h-6 appearance-none bg-transparent cursor-pointer accent-[#FF812E] focus:outline-none"
                />
              </div>

              {/* Anchor threshold labels */}
              <div className="flex justify-between text-[10px] font-mono text-[#4B5563] pt-0.5 tabular-nums">
                <button
                  type="button"
                  onClick={() => handleSelectPreset('backpacker')}
                  className="hover:text-[#111827] cursor-pointer"
                >
                  0% Backpacker
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectPreset('explorer')}
                  className="hover:text-[#111827] cursor-pointer text-center"
                >
                  50% Balanced
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectPreset('express')}
                  className="hover:text-[#111827] cursor-pointer text-right"
                >
                  100% Express
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
