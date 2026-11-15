import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Analytics } from '@vercel/analytics/react';
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
import {
  BedDouble,
  Calendar,
  Map as MapIcon,
  Minus,
  Plus,
  RotateCcw,
  Route,
  Ticket,
  Users,
} from 'lucide-react';
import {
  addDaysIso,
  formatTripDateSpan,
  recalculateDatesAfterReorder,
  totalTripNights,
  updateStopDatesAndCascade,
  updateStopNightsAndCascade,
} from '../shared/dateUtils.ts';
import {
  CURATED_CORRIDOR_OPTIONS,
  DESTINATION_HUBS,
  VOUCHERS_CATALOG,
  createDefaultTrip,
} from '../shared/mockDataset.ts';
import { buildLegsFromStops, rescoreLegs, round2 } from '../shared/smartScore.ts';
import { legTotals } from '../shared/fares.ts';
import { useCurrency } from './currency.tsx';
import { configureAffiliate, type AffiliateConfig } from '../shared/affiliate.ts';
import { registerAirports, type AirportPoint } from '../shared/airports.ts';
import { buildStaySearches } from '../shared/stays.ts';
import type {
  DestinationHub,
  LegTicketPref,
  ModeFilter,
  TicketType,
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
import { StayPanel } from './components/StayPanel.tsx';
import { TopBar } from './components/TopBar.tsx';
import { VoucherDrawer } from './components/VoucherDrawer.tsx';
import { VttsControlPanel } from './components/VttsControlPanel.tsx';
import { WorldMapCanvas } from './components/WorldMapCanvas.tsx';
import type { OverlayLine } from '../shared/groundSchedule.ts';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { logFlightState, verifyLegsMatchResponse } from './flightDebug.ts';

type WorkspacePanel = 'timeline' | 'stays' | 'smart-score' | 'vouchers';

/**
 * The browser has no airport dataset. Every flight segment the API returns carries exact airport
 * coordinates, so remember them: later optimistic rebuilds then anchor to the same airports.
 */
function learnAirports(legs: TripLeg[]): void {
  const points: AirportPoint[] = [];
  for (const leg of legs) {
    for (const option of leg.transitOptions) {
      for (const seg of option.segments ?? []) {
        if (seg.mode !== 'flight') continue;
        points.push({ code: seg.fromCode, name: seg.fromName, lat: seg.fromLat, lng: seg.fromLng });
        points.push({ code: seg.toCode, name: seg.toName, lat: seg.toLat, lng: seg.toLng });
      }
    }
  }
  registerAirports(points);
}

export default function App() {
  const { fmt } = useCurrency();
  // Where tickets come from (set in code/env): shown in the header, never switched from the UI
  const [dataMode, setDataMode] = useState<'live' | 'mock' | undefined>(undefined);
  const [trip, setTrip] = useState<Trip>(() => createDefaultTrip());
  const [destinations, setDestinations] = useState<DestinationHub[]>(DESTINATION_HUBS);
  const [vouchers, setVouchers] = useState<Voucher[]>(VOUCHERS_CATALOG);
  const [isLoadingInitial, setIsLoadingInitial] = useState(true);

  // Sync & workspace UI states
  const [activePanel, setActivePanel] = useState<WorkspacePanel>('timeline');
  // Left pane: the route (stops + transport) or the stays for every destination
  const [leftView, setLeftView] = useState<'route' | 'stays'>('route');
  const [selectedStays, setSelectedStays] = useState<Record<string, string>>({});
  // Bumped when partner ids arrive, so stay links are rebuilt with attribution
  const [affiliateVersion, setAffiliateVersion] = useState(0);
  const [mobileView, setMobileView] = useState<'split-left' | 'split-right'>('split-left');
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all');
  const [hoveredStopId, setHoveredStopId] = useState<string | null>(null);
  const [hoveredLegId, setHoveredLegId] = useState<string | null>(null);
  // Transit routes chosen in a leg's Schedules panel, drawn on the map by leg
  const [transitOverlays, setTransitOverlays] = useState<Record<string, OverlayLine[]>>({});
  const handleTransitOverlay = useCallback((legId: string, lines: OverlayLine[] | null) => {
    setTransitOverlays((prev) => {
      if (!lines && !prev[legId]) return prev;
      const next = { ...prev };
      if (lines) next[legId] = lines;
      else delete next[legId];
      return next;
    });
  }, []);
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

  // Monotonic id for /api/legs/recompute so a slow, older response can't overwrite a newer reorder
  const recomputeRequestIdRef = useRef(0);
  // Dev only: the legs exactly as the API last returned them, to verify nothing rewrites tickets
  const lastApiLegsRef = useRef<{ label: string; legs: TripLeg[] } | null>(null);
  const smartScoreSectionRef = useRef<HTMLDivElement | null>(null);
  const timelineSectionRef = useRef<HTMLDivElement | null>(null);

  // Fetch initial trip, destinations, and vouchers from Express backend
  useEffect(() => {
    let mounted = true;
    async function hydrateFromApi() {
      try {
        fetch('/api/config')
          .then((res) => (res.ok ? res.json() : null))
          .then((config: { dataMode?: 'live' | 'mock' } | null) => {
            if (mounted && config?.dataMode) setDataMode(config.dataMode);
          })
          .catch(() => {
            // header chip simply stays hidden
          });

        // Partner ids first and on their own: they are instant, the trip may wait on live fares
        fetch('/api/affiliate/config')
          .then((res) => (res.ok ? res.json() : null))
          .then((config: AffiliateConfig | null) => {
            if (!mounted || !config) return;
            configureAffiliate(config);
            setAffiliateVersion((v) => v + 1);
          })
          .catch(() => {
            // Links still work without ids; they are just not attributed
          });

        const [tripRes, destRes, voucherRes] = await Promise.all([
          fetch('/api/trips/default'),
          fetch('/api/destinations'),
          fetch('/api/vouchers'),
        ]);
        if (!mounted) return;
        if (tripRes.ok) {
          const tripData: Trip = await tripRes.json();
          learnAirports(tripData.legs);
          lastApiLegsRef.current = { label: 'initial load', legs: tripData.legs };
          logFlightState('initial load (API response)', tripData.legs);
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
      } catch (err) {
        // Fallback to the local SAMPLE dataset (cards are labelled "Sample") if the API is unreachable
        console.warn('[Flights] initial load failed; showing local sample data:', err);
      } finally {
        if (mounted) setIsLoadingInitial(false);
      }
    }
    hydrateFromApi();
    return () => {
      mounted = false;
    };
  }, []);

  // Dev only: after every state change, confirm the ticket fields still equal the last API response
  useEffect(() => {
    const last = lastApiLegsRef.current;
    if (last) verifyLegsMatchResponse(last.label, last.legs, trip.legs);
  }, [trip.legs]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Recompute legs via API (with instant optimistic local fallback) whenever stops change
  const recomputeStopsAndLegs = useCallback(
    async (
      nextStops: TripStop[],
      nextHourlyRate = trip.hourlyTimeValue,
      nextVoucherCodes = trip.appliedVoucherCodes,
      nextTravelers = trip.travelers,
      nextPrefs: Record<string, LegTicketPref> = trip.legPrefs ?? {}
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
        previousSelectedMap,
        {
          profile: trip.travelerProfile,
          passengers: nextTravelers,
          legPrefs: nextPrefs,
          // Fares for an unchanged search stay on screen while the server refreshes them
          previousLegs: trip.legs,
        }
      );

      lastApiLegsRef.current = null; // optimistic legs are local sample data, not an API response
      setTrip((prev) => ({
        ...prev,
        startDate: normalizedStops[0]?.arrivalDate ?? prev.startDate,
        endDate: normalizedStops[normalizedStops.length - 1]?.departureDate ?? prev.endDate,
        stops: normalizedStops,
        legs: optimisticLegs,
        hourlyTimeValue: nextHourlyRate,
        appliedVoucherCodes: nextVoucherCodes,
        travelers: nextTravelers,
        legPrefs: nextPrefs,
      }));

      const requestId = ++recomputeRequestIdRef.current;
      try {
        const res = await fetch('/api/legs/recompute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stops: normalizedStops,
            hourlyTimeValue: nextHourlyRate,
            appliedVoucherCodes: nextVoucherCodes,
            previousSelectedMap,
            travelerProfile: trip.travelerProfile,
            travelers: nextTravelers,
            legPrefs: nextPrefs,
          }),
        });
        if (res.ok) {
          const data: { stops: TripStop[]; legs: TripLeg[] } = await res.json();
          if (requestId !== recomputeRequestIdRef.current) return; // superseded by a newer edit
          learnAirports(data.legs);
          lastApiLegsRef.current = { label: 'recompute', legs: data.legs };
          logFlightState('recompute (API response)', data.legs);
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
    [
      trip.hourlyTimeValue,
      trip.appliedVoucherCodes,
      trip.legs,
      trip.legPrefs,
      trip.travelerProfile,
      trip.travelers,
      vouchers,
    ]
  );

  // Instant client-side Smart Score recalculation for VTTS preset / slider changes
  const applyVttsRate = useCallback(
    (tier: VttsTier, hourlyRateUsd: number) => {
      setTrip((prev) => {
        const activeVouchers = vouchers.filter((v) =>
          prev.appliedVoucherCodes.includes(v.code)
        );
        // Both ticket structures are re-scored: a different time value can change which wins
        const updatedLegs = rescoreLegs(
          prev.legs,
          hourlyRateUsd,
          activeVouchers,
          prev.travelerProfile,
          prev.legPrefs
        );
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

        const updatedLegs = rescoreLegs(
          prev.legs,
          prev.hourlyTimeValue,
          activeVouchers,
          prev.travelerProfile,
          prev.legPrefs
        );

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
      try {
        const res = await fetch('/api/vouchers/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, legs: trip.legs }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as VoucherValidationResult;
      } catch {
        // Previously a network/5xx error rejected unhandled and the drawer showed nothing
        return {
          valid: false,
          reason: 'Could not reach the voucher service. Check your connection and try again.',
          eligibleLegIds: [],
          estimatedSavingsUsd: 0,
        };
      }
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
      activeVouchers,
      undefined,
      { profile: trip.travelerProfile, passengers: trip.travelers }
    );
    const datedStops = recalculateDatesAfterReorder(reordered, prelimLegs);
    recomputeStopsAndLegs(datedStops);
  };

  const handleAddDestination = (hub: DestinationHub) => {
    const lastStop = trip.stops[trip.stops.length - 1];
    const arrivalDate = lastStop ? lastStop.departureDate : '2026-11-21';
    // The first stop of a trip is the origin: a departure date, no nights
    const departureDate = lastStop ? addDaysIso(arrivalDate, hub.recommendedNights) : arrivalDate;

    // Airport-search results carry the airport's own coordinates (the curated city hubs do not)
    if ('airportName' in hub) {
      registerAirports([{ code: hub.iataCode, name: hub.tagline, lat: hub.lat, lng: hub.lng }]);
    }

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
      activeVouchers,
      undefined,
      { profile: trip.travelerProfile, passengers: trip.travelers }
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

  // Travellers flow into every outbound link (flight passengers, hotel guests and rooms)
  const handleChangeTravelers = (delta: number) => {
    const next = Math.min(9, Math.max(1, trip.travelers + delta));
    if (next === trip.travelers) return;
    recomputeStopsAndLegs(trip.stops, trip.hourlyTimeValue, trip.appliedVoucherCodes, next);
  };

  /**
   * One-way vs return for a leg. Choosing marks the type as the traveller's own (the cheaper-fare
   * automation then leaves it alone); `auto` hands the decision back. Return fares are fetched on
   * demand, so this goes through the same optimistic-then-server path as any other edit.
   */
  const handleChangeLegTicket = (
    legId: string,
    change: { type?: TicketType; returnDate?: string; auto?: boolean }
  ) => {
    const prefs: Record<string, LegTicketPref> = { ...(trip.legPrefs ?? {}) };
    if (change.auto) {
      delete prefs[legId];
    } else {
      const leg = trip.legs.find((l) => l.id === legId);
      const current: LegTicketPref = prefs[legId] ?? { type: leg?.ticketType ?? 'one-way' };
      prefs[legId] = {
        ...current,
        ...(change.type ? { type: change.type } : {}),
        ...(change.returnDate ? { returnDate: change.returnDate } : {}),
      };
    }
    recomputeStopsAndLegs(
      trip.stops,
      trip.hourlyTimeValue,
      trip.appliedVoucherCodes,
      trip.travelers,
      prefs
    );
  };

  const handleOpenStays = (stopId: string) => {
    setActivePanel('stays');
    setLeftView('stays');
    setMobileView('split-left');
    // The stays view mounts on this render; scroll once its panels exist
    setTimeout(() => {
      document
        .getElementById(`stays-${stopId}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
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
    setOptimizerResult(null); // don't show a stale result for a different stop order
    try {
      const res = await fetch('/api/optimize-route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stops: trip.stops,
          hourlyTimeValue: trip.hourlyTimeValue,
          appliedVoucherCodes: trip.appliedVoucherCodes,
          travelerProfile: trip.travelerProfile,
          travelers: trip.travelers,
          lockOrigin: true,
        }),
      });
      if (res.ok) {
        const data: RouteOptimizationResult = await res.json();
        setOptimizerResult(data);
      }
    } catch (err) {
      console.error('[Route Optimizer] Request failed:', err);
    } finally {
      setIsOptimizing(false);
    }
  };

  const handleApplyOptimized = (result: RouteOptimizationResult) => {
    const datedStops = recalculateDatesAfterReorder(
      result.optimizedStops,
      result.optimizedLegs
    );
    // The optimizer ranks with curated/synthesized corridors. Installing its legs directly would
    // replace live fares with sample data, so apply only the new stop order and re-query every leg
    // through the same live pipeline (optimistic local update first, API reconcile second).
    recomputeStopsAndLegs(datedStops);
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

  const handleNavPanelSelect = (panel: WorkspacePanel) => {
    setActivePanel(panel);
    setMobileView('split-left');
    if (panel === 'stays') setLeftView('stays');
    if (panel === 'timeline') setLeftView('route');
    if (panel === 'smart-score' && smartScoreSectionRef.current) {
      smartScoreSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (timelineSectionRef.current && (panel === 'timeline' || panel === 'stays')) {
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
      // A return ticket is counted once, on the leg that carries it; the leg it covers adds nothing
      const t = legTotals(leg);
      totalCostUsd += t.costUsd;
      totalSavingsUsd += t.savingsUsd;
      totalHours += t.hours;
      totalSmartScore += t.score;
    }

    return {
      totalCostUsd: round2(totalCostUsd),
      totalSavingsUsd: round2(totalSavingsUsd),
      totalHours: round2(totalHours),
      totalSmartScore: round2(totalSmartScore),
      totalDistanceKm,
    };
  }, [trip.legs]);

  const totalNights = useMemo(() => totalTripNights(trip.stops), [trip.stops]);

  // Stays for every destination, ranked by the same Smart Score inputs as the transport options.
  // `affiliateVersion` is a dependency because the links are rebuilt once partner ids arrive.
  const staySearches = useMemo(
    () => buildStaySearches(trip.stops, trip.travelers, trip.hourlyTimeValue, trip.travelerProfile),
    [trip.stops, trip.travelers, trip.hourlyTimeValue, trip.travelerProfile, affiliateVersion]
  );
  const stayByStopId = useMemo(
    () => Object.fromEntries(staySearches.map((s) => [s.stopId, s])),
    [staySearches]
  );
  const staysTotalUsd = useMemo(
    () =>
      staySearches.reduce((sum, search) => {
        const picked =
          search.options.find((o) => o.id === selectedStays[search.stopId]) ?? search.options[0];
        return sum + (picked?.totalPriceUsd ?? 0);
      }, 0),
    [staySearches, selectedStays]
  );
  const handleSelectStay = (stopId: string, optionId: string) =>
    setSelectedStays((prev) => ({ ...prev, [stopId]: optionId }));

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
        dataMode={dataMode}
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
                {trip.stops.length} stops · {totalNights} nights ·{' '}
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

              <div
                role="group"
                aria-label="Travellers"
                className="inline-flex items-center gap-0.5 px-1.5 py-1 rounded-xl bg-white border border-neutral-200/80 text-xs font-semibold text-[#111827] shadow-xs shrink-0"
              >
                <Users className="w-3.5 h-3.5 text-[#FF812E] ml-1" />
                <button
                  type="button"
                  aria-label="Fewer travellers"
                  onClick={() => handleChangeTravelers(-1)}
                  disabled={trip.travelers <= 1}
                  className="w-6 h-6 flex items-center justify-center rounded-lg text-[#4B5563] hover:text-[#111827] hover:bg-neutral-100 disabled:opacity-40 cursor-pointer"
                >
                  <Minus className="w-3 h-3" />
                </button>
                <span className="font-mono tabular-nums min-w-4 text-center">{trip.travelers}</span>
                <button
                  type="button"
                  aria-label="More travellers"
                  onClick={() => handleChangeTravelers(1)}
                  disabled={trip.travelers >= 9}
                  className="w-6 h-6 flex items-center justify-center rounded-lg text-[#4B5563] hover:text-[#111827] hover:bg-neutral-100 disabled:opacity-40 cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                </button>
              </div>

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
              <div
                role="tablist"
                aria-label="Itinerary view"
                className="inline-flex p-1 rounded-xl bg-neutral-100"
              >
                {(
                  [
                    { id: 'route', label: 'Itinerary & Corridors', icon: Route },
                    { id: 'stays', label: `Stays (${staySearches.length})`, icon: BedDouble },
                  ] as const
                ).map((tab) => {
                  const Icon = tab.icon;
                  const active = leftView === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => handleNavPanelSelect(tab.id === 'route' ? 'timeline' : 'stays')}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors cursor-pointer whitespace-nowrap ${
                        active
                          ? 'bg-white text-[#111827] font-bold shadow-xs'
                          : 'text-[#4B5563] font-medium hover:text-[#111827]'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5 text-[#FF812E]" />
                      <span>{tab.label}</span>
                    </button>
                  );
                })}
              </div>
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
            ) : leftView === 'stays' ? (
              <div className="space-y-3">
                <div className="rounded-2xl bg-white border border-neutral-200/80 shadow-sm px-4 py-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-[#4B5563]">
                    <span className="font-semibold text-[#111827]">
                      {staySearches.length} stay{staySearches.length === 1 ? '' : 's'} ·{' '}
                      {totalNights} nights · {trip.travelers} guest{trip.travelers === 1 ? '' : 's'}
                    </span>
                    <div className="mt-0.5">
                      Ranked by Smart Score at your travel pacing. Prices are typical estimates;
                      the partner shows live rates.
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[11px] font-medium text-[#4B5563]">Est. stays total</div>
                    <div className="font-display text-lg font-bold text-[#111827] tabular-nums">
                      ~{fmt(staysTotalUsd)}
                    </div>
                  </div>
                </div>
                {staySearches.length === 0 ? (
                  <div className="rounded-2xl bg-white border border-neutral-200/80 p-6 text-center text-xs text-[#4B5563]">
                    Add a destination after your starting point to compare places to stay.
                  </div>
                ) : (
                  staySearches.map((search) => (
                    <StayPanel
                      key={search.stopId}
                      search={search}
                      selectedOptionId={selectedStays[search.stopId]}
                      defaultExpanded
                      onSelectOption={handleSelectStay}
                    />
                  ))
                )}
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
                      const staySearch = stayByStopId[stop.id];
                      return (
                        <div key={stop.id}>
                          <SortableStopCard
                            stop={stop}
                            index={idx}
                            isOrigin={idx === 0}
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

                          {staySearch && (
                            <StayPanel
                              search={staySearch}
                              selectedOptionId={selectedStays[stop.id]}
                              inTimeline
                              onSelectOption={handleSelectStay}
                            />
                          )}

                          {nextLeg && (
                            <LegTransitPanel
                              leg={nextLeg}
                              pairedLeg={trip.legs.find((l) => l.id === nextLeg.pairedLegId)}
                              coveredByLeg={trip.legs.find((l) => l.id === nextLeg.coveredByLegId)}
                              onChangeTicket={handleChangeLegTicket}
                              modeFilter={modeFilter}
                              vouchers={vouchers}
                              isActive={
                                hoveredLegId === nextLeg.id || activeLegId === nextLeg.id
                              }
                              onActivateLeg={setActiveLegId}
                              onHoverLeg={setHoveredLegId}
                              onSelectOption={handleSelectOption}
                              fromStop={stop}
                              toStop={trip.stops.find((s) => s.id === nextLeg.toStopId)}
                              travellers={trip.travelers}
                              onTransitOverlay={handleTransitOverlay}
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
          <ErrorBoundary
            label="map"
            fallback={
              <div className="flex h-full items-center justify-center bg-neutral-50 p-6 text-center text-sm text-neutral-500">
                The map couldn't be displayed (WebGL may be unavailable). Your itinerary still works.
              </div>
            }
          >
            <WorldMapCanvas
              transitOverlays={transitOverlays}
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
              onOpenStays={handleOpenStays}
            />
          </ErrorBoundary>
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

      <Analytics />
    </div>
  );
}
