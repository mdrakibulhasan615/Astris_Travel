import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { Calendar, Map as MapIcon, Plus, RotateCcw, Route, Ticket } from 'lucide-react';
import {
  addDaysIso,
  formatTripDateSpan,
  recalculateDatesAfterReorder,
  updateStopDatesAndCascade,
  updateStopNightsAndCascade,
} from '../shared/dateUtils.ts';
import {
  CURATED_CORRIDOR_OPTIONS,
  DESTINATION_HUBS,
  VOUCHERS_CATALOG,
  createDefaultTrip,
} from '../shared/mockDataset.ts';
import {
  buildLegsFromStops,
  recalculateOptionsWithVttsAndVouchers,
  round2,
} from '../shared/smartScore.ts';
import type {
  DestinationHub,
  ModeFilter,
  RouteOptimizationResult,
  Trip,
  TripLeg,
  TripStop,
  Voucher,
  VoucherValidationResult,
  VttsTier,
} from '../shared/types.ts';
import { AddStopModal } from './components/AddStopModal.tsx';
import { LegTransitPanel } from './components/LegTransitPanel.tsx';
import { MultiDestDatePickerModal } from './components/MultiDestDatePickerModal.tsx';
import { RouteOptimizerModal } from './components/RouteOptimizerModal.tsx';
import { SortableStopCard } from './components/SortableStopCard.tsx';
import { TopBar } from './components/TopBar.tsx';
import { VoucherDrawer } from './components/VoucherDrawer.tsx';
import { VttsControlPanel } from './components/VttsControlPanel.tsx';
import { WorldMapCanvas } from './components/WorldMapCanvas.tsx';

export default function App() {
  const [trip, setTrip] = useState<Trip>(() => createDefaultTrip());
  const [destinations, setDestinations] = useState<DestinationHub[]>(DESTINATION_HUBS);
  const [vouchers, setVouchers] = useState<Voucher[]>(VOUCHERS_CATALOG);
  const [isLoadingInitial, setIsLoadingInitial] = useState(true);

  // Sync & workspace UI states
  const [activePanel, setActivePanel] = useState<'timeline' | 'smart-score' | 'vouchers'>('timeline');
  const [mobileView, setMobileView] = useState<'split-left' | 'split-right'>('split-left');
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all');
  const [hoveredStopId, setHoveredStopId] = useState<string | null>(null);
  const [hoveredLegId, setHoveredLegId] = useState<string | null>(null);
  const [activeLegId, setActiveLegId] = useState<string | null>(null);
  const [focusTarget, setFocusTarget] = useState<{
    lat: number;
    lng: number;
    zoom?: number;
    ts: number;
  } | null>(null);

  // Modals & Drawers
  const [isAddStopOpen, setIsAddStopOpen] = useState(false);
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
  const [datePickerStopId, setDatePickerStopId] = useState<string | null>(null);
  const [isVoucherDrawerOpen, setIsVoucherDrawerOpen] = useState(false);
  const [isOptimizerOpen, setIsOptimizerOpen] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [optimizerResult, setOptimizerResult] = useState<RouteOptimizationResult | null>(null);

  const smartScoreSectionRef = useRef<HTMLDivElement | null>(null);
  const timelineSectionRef = useRef<HTMLDivElement | null>(null);

  // Fetch initial trip, destinations, and vouchers from Express backend
  useEffect(() => {
    let mounted = true;
    async function hydrateFromApi() {
      try {
        const [tripRes, destRes, voucherRes] = await Promise.all([
          fetch('/api/trips/default'),
          fetch('/api/destinations'),
          fetch('/api/vouchers'),
        ]);
        if (!mounted) return;
        if (tripRes.ok) {
          const tripData: Trip = await tripRes.json();
          setTrip(tripData);
          if (tripData.legs[0]) setActiveLegId(tripData.legs[0].id);
        }
        if (destRes.ok) {
          const destData: { destinations: DestinationHub[] } = await destRes.json();
          setDestinations(destData.destinations);
        }
        if (voucherRes.ok) {
          const voucherData: { vouchers: Voucher[] } = await voucherRes.json();
          setVouchers(voucherData.vouchers);
        }
      } catch {
        // Fallback to local initial dataset cleanly if network request fails
      } finally {
        if (mounted) setIsLoadingInitial(false);
      }
    }
    hydrateFromApi();
    return () => {
      mounted = false;
    };
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Recompute legs via API (with instant optimistic local fallback) whenever stops change
  const recomputeStopsAndLegs = useCallback(
    async (
      nextStops: TripStop[],
      nextHourlyRate = trip.hourlyTimeValue,
      nextVoucherCodes = trip.appliedVoucherCodes
    ) => {
      const previousSelectedMap: Record<string, string> = {};
      for (const leg of trip.legs) {
        previousSelectedMap[leg.id] = leg.selectedOptionId;
      }

      const normalizedStops = nextStops.map((s, idx) => ({ ...s, order: idx + 1 }));
      const activeVouchers = vouchers.filter((v) => nextVoucherCodes.includes(v.code));

      // Instant optimistic update so DnD & map arcs update at 60fps
      const optimisticLegs = buildLegsFromStops(
        normalizedStops,
        CURATED_CORRIDOR_OPTIONS,
        vouchers,
        nextHourlyRate,
        activeVouchers,
        previousSelectedMap
      );

      setTrip((prev) => ({
        ...prev,
        startDate: normalizedStops[0]?.arrivalDate ?? prev.startDate,
        endDate: normalizedStops[normalizedStops.length - 1]?.departureDate ?? prev.endDate,
        stops: normalizedStops,
        legs: optimisticLegs,
        hourlyTimeValue: nextHourlyRate,
        appliedVoucherCodes: nextVoucherCodes,
      }));

      try {
        const res = await fetch('/api/legs/recompute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stops: normalizedStops,
            hourlyTimeValue: nextHourlyRate,
            appliedVoucherCodes: nextVoucherCodes,
            previousSelectedMap,
          }),
        });
        if (res.ok) {
          const data: { stops: TripStop[]; legs: TripLeg[] } = await res.json();
          setTrip((prev) => ({
            ...prev,
            startDate: data.stops[0]?.arrivalDate ?? prev.startDate,
            endDate: data.stops[data.stops.length - 1]?.departureDate ?? prev.endDate,
            stops: data.stops,
            legs: data.legs,
          }));
        }
      } catch {
        // Optimistic state already applied
      }
    },
    [trip.hourlyTimeValue, trip.appliedVoucherCodes, trip.legs, vouchers]
  );

  // Instant client-side Smart Score recalculation for VTTS preset / slider changes
  const applyVttsRate = useCallback(
    (tier: VttsTier, hourlyRateUsd: number) => {
      setTrip((prev) => {
        const activeVouchers = vouchers.filter((v) =>
          prev.appliedVoucherCodes.includes(v.code)
        );
        const updatedLegs = prev.legs.map((leg) => {
          const ranked = recalculateOptionsWithVttsAndVouchers(
            leg.transitOptions,
            hourlyRateUsd,
            activeVouchers
          );
          const keepSelected = ranked.some((o) => o.id === leg.selectedOptionId);
          return {
            ...leg,
            selectedOptionId: keepSelected ? leg.selectedOptionId : ranked[0]?.id ?? '',
            transitOptions: ranked,
          };
        });
        return {
          ...prev,
          vttsTier: tier,
          hourlyTimeValue: hourlyRateUsd,
          legs: updatedLegs,
        };
      });
    },
    [vouchers]
  );

  const handleToggleVoucher = useCallback(
    (code: string) => {
      setTrip((prev) => {
        const exists = prev.appliedVoucherCodes.includes(code);
        const nextCodes = exists
          ? prev.appliedVoucherCodes.filter((c) => c !== code)
          : [...prev.appliedVoucherCodes, code];
        const activeVouchers = vouchers.filter((v) => nextCodes.includes(v.code));

        const updatedLegs = prev.legs.map((leg) => {
          const ranked = recalculateOptionsWithVttsAndVouchers(
            leg.transitOptions,
            prev.hourlyTimeValue,
            activeVouchers
          );
          return {
            ...leg,
            transitOptions: ranked,
          };
        });

        return {
          ...prev,
          appliedVoucherCodes: nextCodes,
          legs: updatedLegs,
        };
      });
    },
    [vouchers]
  );

  const handleValidateVoucherCode = useCallback(
    async (code: string): Promise<VoucherValidationResult> => {
      const res = await fetch('/api/vouchers/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, legs: trip.legs }),
      });
      return res.json();
    },
    [trip.legs]
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = trip.stops.findIndex((s) => s.id === active.id);
    const newIndex = trip.stops.findIndex((s) => s.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(trip.stops, oldIndex, newIndex).map((s, idx) => ({
      ...s,
      order: idx + 1,
    }));
    const activeVouchers = vouchers.filter((v) =>
      trip.appliedVoucherCodes.includes(v.code)
    );
    const prelimLegs = buildLegsFromStops(
      reordered,
      CURATED_CORRIDOR_OPTIONS,
      vouchers,
      trip.hourlyTimeValue,
      activeVouchers
    );
    const datedStops = recalculateDatesAfterReorder(reordered, prelimLegs);
    recomputeStopsAndLegs(datedStops);
  };

  const handleAddDestination = (hub: DestinationHub) => {
    const lastStop = trip.stops[trip.stops.length - 1];
    const arrivalDate = lastStop ? lastStop.departureDate : '2026-11-18';
    const departureDate = addDaysIso(arrivalDate, hub.recommendedNights);

    const newStop: TripStop = {
      id: `stop-${hub.iataCode.toLowerCase()}-${Date.now()}`,
      order: trip.stops.length + 1,
      city: hub.city,
      country: hub.country,
      iataCode: hub.iataCode,
      lat: hub.lat,
      lng: hub.lng,
      stayNights: hub.recommendedNights,
      arrivalDate,
      departureDate,
      notes: hub.tagline,
    };

    const nextStops = [...trip.stops, newStop];
    recomputeStopsAndLegs(nextStops);
    setFocusTarget({ lat: hub.lat, lng: hub.lng, zoom: 4.5, ts: Date.now() });
  };

  const handleRemoveStop = (stopId: string) => {
    const remaining = trip.stops
      .filter((s) => s.id !== stopId)
      .map((s, idx) => ({ ...s, order: idx + 1 }));
    const activeVouchers = vouchers.filter((v) =>
      trip.appliedVoucherCodes.includes(v.code)
    );
    const prelimLegs = buildLegsFromStops(
      remaining,
      CURATED_CORRIDOR_OPTIONS,
      vouchers,
      trip.hourlyTimeValue,
      activeVouchers
    );
    const datedStops = recalculateDatesAfterReorder(remaining, prelimLegs);
    recomputeStopsAndLegs(datedStops);
  };

  const handleUpdateNights = (stopId: string, delta: number) => {
    setTrip((prev) => {
      const nextStops = updateStopNightsAndCascade(prev.stops, stopId, delta);
      return {
        ...prev,
        startDate: nextStops[0]?.arrivalDate ?? prev.startDate,
        endDate: nextStops[nextStops.length - 1]?.departureDate ?? prev.endDate,
        stops: nextStops,
      };
    });
  };

  const handleOpenDatePicker = (stopId?: string) => {
    setDatePickerStopId(stopId ?? trip.stops[0]?.id ?? null);
    setIsDatePickerOpen(true);
  };

  const handleUpdateStopDates = (
    stopId: string,
    arrivalDate: string,
    departureDate: string
  ) => {
    setTrip((prev) => {
      const nextStops = updateStopDatesAndCascade(
        prev.stops,
        stopId,
        arrivalDate,
        departureDate
      );
      return {
        ...prev,
        startDate: nextStops[0]?.arrivalDate ?? prev.startDate,
        endDate: nextStops[nextStops.length - 1]?.departureDate ?? prev.endDate,
        stops: nextStops,
      };
    });
  };

  const handleSelectOption = (legId: string, optionId: string) => {
    setTrip((prev) => ({
      ...prev,
      legs: prev.legs.map((leg) =>
        leg.id === legId ? { ...leg, selectedOptionId: optionId } : leg
      ),
    }));
  };

  const handleOptimizeRoute = async () => {
    setIsOptimizerOpen(true);
    setIsOptimizing(true);
    try {
      const res = await fetch('/api/optimize-route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stops: trip.stops,
          hourlyTimeValue: trip.hourlyTimeValue,
          appliedVoucherCodes: trip.appliedVoucherCodes,
          lockOrigin: true,
        }),
      });
      if (res.ok) {
        const data: RouteOptimizationResult = await res.json();
        setOptimizerResult(data);
      }
    } finally {
      setIsOptimizing(false);
    }
  };

  const handleApplyOptimized = (result: RouteOptimizationResult) => {
    const datedStops = recalculateDatesAfterReorder(
      result.optimizedStops,
      result.optimizedLegs
    );
    setTrip((prev) => ({
      ...prev,
      startDate: datedStops[0]?.arrivalDate ?? prev.startDate,
      endDate: datedStops[datedStops.length - 1]?.departureDate ?? prev.endDate,
      stops: datedStops,
      legs: result.optimizedLegs,
    }));
    if (result.optimizedLegs[0]) {
      setActiveLegId(result.optimizedLegs[0].id);
    }
  };

  const handleRestoreDefaultTrip = () => {
    const fresh = createDefaultTrip();
    setTrip(fresh);
    setModeFilter('all');
    if (fresh.legs[0]) setActiveLegId(fresh.legs[0].id);
  };

  const handleNavPanelSelect = (panel: 'timeline' | 'smart-score' | 'vouchers') => {
    setActivePanel(panel);
    setMobileView('split-left');
    if (panel === 'smart-score' && smartScoreSectionRef.current) {
      smartScoreSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (panel === 'timeline' && timelineSectionRef.current) {
      timelineSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // Compute live trip totals
  const totals = useMemo(() => {
    let totalCostUsd = 0;
    let totalSavingsUsd = 0;
    let totalHours = 0;
    let totalSmartScore = 0;
    let totalDistanceKm = 0;

    for (const leg of trip.legs) {
      totalDistanceKm += leg.distanceKm;
      const selected =
        leg.transitOptions.find((o) => o.id === leg.selectedOptionId) ??
        leg.transitOptions[0];
      if (selected) {
        totalCostUsd += selected.discountedPriceUsd;
        totalSavingsUsd += selected.smartScoreBreakdown.discountAppliedUsd;
        totalHours += selected.inVehicleHours + selected.layoverHours;
        totalSmartScore += selected.smartScore;
      }
    }

    return {
      totalCostUsd: round2(totalCostUsd),
      totalSavingsUsd: round2(totalSavingsUsd),
      totalHours: round2(totalHours),
      totalSmartScore: round2(totalSmartScore),
      totalDistanceKm,
    };
  }, [trip.legs]);

  const totalNights = useMemo(
    () => trip.stops.reduce((sum, s) => sum + s.stayNights, 0),
    [trip.stops]
  );

  return (
    <div className="min-h-screen lg:h-screen flex flex-col bg-[#FAFAFA] text-[#111827] lg:overflow-hidden">
      <TopBar
        activePanel={activePanel}
        onSelectPanel={handleNavPanelSelect}
        onOpenAddStop={() => setIsAddStopOpen(true)}
        onOpenVouchers={() => setIsVoucherDrawerOpen(true)}
        onOptimizeRoute={handleOptimizeRoute}
        isOptimizing={isOptimizing}
        activeVoucherCount={trip.appliedVoucherCodes.length}
      />

      {/* Mobile View Switcher (keeps sticky height well under 15%) */}
      <div className="lg:hidden px-4 py-2 bg-white border-b border-neutral-200/80 flex items-center justify-between gap-2">
        <div className="inline-flex p-1 rounded-xl bg-neutral-100">
          <button
            type="button"
            onClick={() => setMobileView('split-left')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              mobileView === 'split-left'
                ? 'bg-white text-[#111827] shadow-xs'
                : 'text-[#4B5563]'
            }`}
          >
            Itinerary ({trip.stops.length})
          </button>
          <button
            type="button"
            onClick={() => setMobileView('split-right')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              mobileView === 'split-right'
                ? 'bg-white text-[#111827] shadow-xs'
                : 'text-[#4B5563]'
            }`}
          >
            <MapIcon className="w-3.5 h-3.5 text-[#FF812E]" />
            <span>Map</span>
          </button>
        </div>

        <button
          type="button"
          onClick={() => setIsAddStopOpen(true)}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl border border-neutral-200 text-xs font-semibold text-[#111827] bg-white"
        >
          <Plus className="w-3.5 h-3.5 text-[#FF812E]" />
          <span>Add Stop</span>
        </button>
      </div>

      {/* Split-Screen Master Workspace */}
      <main className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(460px,47%)_1fr] items-stretch">
        {/* Left Side: Scrollable Timeline & Multi-Modal Transit Workspace */}
        <div
          className={`${
            mobileView === 'split-left' ? 'block' : 'hidden lg:block'
          } h-full overflow-y-auto astris-scroll px-5 py-5 lg:px-7 lg:py-6 space-y-5`}
        >
          {/* Trip Header & Quick Workspace Actions */}
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="text-xs font-medium text-[#4B5563] tabular-nums">
                {trip.stops.length} destinations · {totalNights} nights ·{' '}
                {trip.legs.length} transit corridors
              </div>
              <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-[#111827]">
                {trip.title}
              </h1>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => handleOpenDatePicker(trip.stops[0]?.id)}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border border-neutral-200/80 hover:border-[#FFD6BA] hover:bg-[#FFF4ED] text-xs font-mono font-semibold text-[#111827] shadow-xs transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums"
              >
                <Calendar className="w-3.5 h-3.5 text-[#FF812E]" />
                <span>{formatTripDateSpan(trip.stops)}</span>
              </button>

              <button
                type="button"
                onClick={() => setIsVoucherDrawerOpen(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white border border-neutral-200/80 hover:border-neutral-300 text-xs font-semibold text-[#111827] shadow-xs transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Ticket className="w-3.5 h-3.5 text-[#FF812E]" />
                <span>Vouchers ({trip.appliedVoucherCodes.length})</span>
              </button>

              <button
                type="button"
                onClick={() => setIsAddStopOpen(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white border border-neutral-200/80 hover:border-[#FFD6BA] hover:bg-[#FFF4ED] text-xs font-semibold text-[#111827] shadow-xs transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5 text-[#FF812E]" />
                <span>Add Stop</span>
              </button>
            </div>
          </div>

          {/* VTTS Smart Score Controls */}
          <div ref={smartScoreSectionRef}>
            <VttsControlPanel
              vttsTier={trip.vttsTier}
              hourlyTimeValue={trip.hourlyTimeValue}
              totalCostUsd={totals.totalCostUsd}
              totalSavingsUsd={totals.totalSavingsUsd}
              totalHours={totals.totalHours}
              totalSmartScore={totals.totalSmartScore}
              totalDistanceKm={totals.totalDistanceKm}
              onSelectPreset={(tier, rate) => applyVttsRate(tier, rate)}
              onChangeCustomRate={(rate) => applyVttsRate('custom', rate)}
            />
          </div>

          {/* Drag-and-Drop Multi-Destination Timeline */}
          <section ref={timelineSectionRef} aria-label="Destination timeline" className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-display text-sm font-bold text-[#111827]">
                Itinerary &amp; Corridors
              </h2>
              {trip.stops.length !== 4 && (
                <button
                  type="button"
                  onClick={handleRestoreDefaultTrip}
                  className="inline-flex items-center gap-1 text-xs font-medium text-[#4B5563] hover:text-[#111827] cursor-pointer whitespace-nowrap"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Reset 4-stop route</span>
                </button>
              )}
            </div>

            {isLoadingInitial ? (
              <div className="space-y-3">
                <div className="h-24 rounded-2xl bg-white border border-neutral-200/80 animate-pulse" />
                <div className="h-24 rounded-2xl bg-white border border-neutral-200/80 animate-pulse" />
              </div>
            ) : trip.stops.length === 0 ? (
              <div className="rounded-2xl bg-white border border-neutral-200/80 p-8 text-center space-y-3">
                <Route className="w-8 h-8 text-[#FF812E] mx-auto" />
                <div className="font-display text-base font-bold text-[#111827]">
                  No Stops Added
                </div>
                <div className="flex items-center justify-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setIsAddStopOpen(true)}
                    className="px-4 py-2 rounded-xl bg-[#FF812E] hover:bg-[#E56B1A] text-white text-xs font-semibold cursor-pointer"
                  >
                    Add Destination
                  </button>
                  <button
                    type="button"
                    onClick={handleRestoreDefaultTrip}
                    className="px-4 py-2 rounded-xl border border-neutral-200 text-xs font-semibold text-[#111827] hover:bg-neutral-50 cursor-pointer"
                  >
                    Restore Default Trip
                  </button>
                </div>
              </div>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={trip.stops.map((s) => s.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-1">
                    {trip.stops.map((stop, idx) => {
                      const nextLeg = trip.legs[idx];
                      return (
                        <div key={stop.id}>
                          <SortableStopCard
                            stop={stop}
                            index={idx}
                            isHovered={hoveredStopId === stop.id}
                            canRemove={trip.stops.length > 2}
                            onHoverStop={setHoveredStopId}
                            onFocusStop={(s) =>
                              setFocusTarget({ lat: s.lat, lng: s.lng, zoom: 5.2, ts: Date.now() })
                            }
                            onOpenDatePicker={handleOpenDatePicker}
                            onUpdateNights={handleUpdateNights}
                            onRemoveStop={handleRemoveStop}
                          />

                          {nextLeg && (
                            <LegTransitPanel
                              leg={nextLeg}
                              modeFilter={modeFilter}
                              vouchers={vouchers}
                              isActive={
                                hoveredLegId === nextLeg.id || activeLegId === nextLeg.id
                              }
                              onActivateLeg={setActiveLegId}
                              onHoverLeg={setHoveredLegId}
                              onSelectOption={handleSelectOption}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </section>
        </div>

        {/* Right Side: Sticky Interactive MapLibre GL Canvas */}
        <div
          className={`${
            mobileView === 'split-right' ? 'block h-[75vh]' : 'hidden lg:block lg:h-full'
          } relative border-l border-neutral-200/80`}
        >
          <WorldMapCanvas
            stops={trip.stops}
            legs={trip.legs}
            modeFilter={modeFilter}
            hoveredStopId={hoveredStopId}
            hoveredLegId={hoveredLegId}
            activeLegId={activeLegId}
            focusTarget={focusTarget}
            onChangeModeFilter={setModeFilter}
            onHoverStop={setHoveredStopId}
            onSelectLeg={(legId) => {
              setActiveLegId(legId);
            }}
          />
        </div>
      </main>

      {/* Modals & Drawers */}
      <AddStopModal
        isOpen={isAddStopOpen}
        destinations={destinations}
        currentStops={trip.stops}
        onClose={() => setIsAddStopOpen(false)}
        onAddDestination={handleAddDestination}
      />

      <RouteOptimizerModal
        isOpen={isOptimizerOpen}
        isLoading={isOptimizing}
        result={optimizerResult}
        onClose={() => setIsOptimizerOpen(false)}
        onApplyOptimized={handleApplyOptimized}
      />

      <MultiDestDatePickerModal
        isOpen={isDatePickerOpen}
        stops={trip.stops}
        initialStopId={datePickerStopId}
        onClose={() => setIsDatePickerOpen(false)}
        onUpdateStopDates={handleUpdateStopDates}
      />

      <VoucherDrawer
        isOpen={isVoucherDrawerOpen}
        vouchers={vouchers}
        appliedCodes={trip.appliedVoucherCodes}
        legs={trip.legs}
        onClose={() => setIsVoucherDrawerOpen(false)}
        onToggleVoucher={handleToggleVoucher}
        onValidateCode={handleValidateVoucherCode}
      />
    </div>
  );
}
