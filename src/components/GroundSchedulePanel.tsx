import { useEffect, useMemo, useState } from 'react';
import {
  Bus,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Footprints,
  Ship,
  TrainFront,
  TramFront,
} from 'lucide-react';
import {
  formatMinutes,
  routeToOverlay,
  type GroundSchedules,
  type OverlayLine,
  type TransitStep,
  type TransitVehicle,
  type TwelveGoRoute,
} from '../../shared/groundSchedule.ts';
import type { TripLeg, TripStop } from '../../shared/types.ts';
import { useCurrency } from '../currency.tsx';

interface GroundSchedulePanelProps {
  leg: TripLeg;
  fromStop: TripStop;
  toStop: TripStop;
  travellers: number;
  /** Lines to draw on the map for the chosen transit route; null clears them. */
  onOverlay: (legId: string, lines: OverlayLine[] | null) => void;
}

const VEHICLE_COLOR: Record<TransitVehicle, string> = {
  bus: '#F97316',
  train: '#2563EB',
  subway: '#2563EB',
  tram: '#2563EB',
  ferry: '#0284C7',
  other: '#4B5563',
};

function VehicleIcon({ vehicle, className }: { vehicle?: TransitVehicle | TwelveGoRoute['mode']; className?: string }) {
  if (vehicle === 'train') return <TrainFront className={className} aria-hidden="true" />;
  if (vehicle === 'subway' || vehicle === 'tram') return <TramFront className={className} aria-hidden="true" />;
  if (vehicle === 'ferry') return <Ship className={className} aria-hidden="true" />;
  return <Bus className={className} aria-hidden="true" />;
}

function StepRow({ step }: { step: TransitStep }) {
  if (step.kind === 'walk') {
    return (
      <li className="flex items-center gap-2 text-[11px] text-[#4B5563]">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-100">
          <Footprints className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0">
          {step.instruction ?? 'Walk'} · {formatMinutes(step.durationMinutes)}
          {step.distanceMeters > 0 && ` (${step.distanceMeters >= 1000 ? `${(step.distanceMeters / 1000).toFixed(1)} km` : `${step.distanceMeters} m`})`}
        </span>
      </li>
    );
  }
  const color = step.lineColor || VEHICLE_COLOR[step.vehicle ?? 'other'];
  return (
    <li className="flex items-start gap-2 text-[11px]">
      <span
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white"
        style={{ background: color }}
      >
        <VehicleIcon vehicle={step.vehicle} className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 text-[#111827]">
        <div className="font-semibold">
          {[step.lineName, step.lineShortName].filter(Boolean).join(' ') || 'Public transport'}
          {step.headsign && <span className="font-normal text-[#4B5563]"> towards {step.headsign}</span>}
        </div>
        <div className="text-[#4B5563]">
          {step.fromStop} → {step.toStop}
        </div>
        <div className="font-mono tabular-nums text-[#4B5563]">
          {step.departureText && step.arrivalText ? `${step.departureText} → ${step.arrivalText} · ` : ''}
          {formatMinutes(step.durationMinutes)}
          {step.stopCount ? ` · ${step.stopCount} stops` : ''}
        </div>
        {step.operator && <div className="text-[10px] text-[#6B7280]">{step.operator}</div>}
      </div>
    </li>
  );
}

function TwelveGoRow({ route }: { route: TwelveGoRoute }) {
  const { fmt } = useCurrency();
  const duration =
    route.durationMinMinutes === undefined
      ? null
      : route.durationMaxMinutes && route.durationMaxMinutes !== route.durationMinMinutes
        ? `${formatMinutes(route.durationMinMinutes)} – ${formatMinutes(route.durationMaxMinutes)}`
        : formatMinutes(route.durationMinMinutes);
  const price =
    route.priceMinUsd === undefined
      ? null
      : route.priceMaxUsd && route.priceMaxUsd !== route.priceMinUsd
        ? `${fmt(route.priceMinUsd)} – ${fmt(route.priceMaxUsd)}`
        : fmt(route.priceMinUsd);
  const modeLabel = route.mode === 'taxi' ? 'Taxi' : route.mode[0].toUpperCase() + route.mode.slice(1);
  return (
    <li className="rounded-xl border border-neutral-200/80 bg-white p-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[#111827]">
            <VehicleIcon vehicle={route.mode} className="h-3.5 w-3.5 shrink-0 text-[#FF812E]" />
            {modeLabel} · {route.from} → {route.to}
          </div>
          <div className="mt-0.5 text-[11px] text-[#4B5563]">
            {[duration, price && `${price} per person`, !route.exact && 'nearby terminals'].filter(Boolean).join(' · ')}
          </div>
        </div>
        <a
          href={route.url}
          target="_blank"
          rel="sponsored noopener noreferrer"
          title="Opens this route on 12Go with the date and travellers filled in"
          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[#FF812E] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#E56B1A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E] focus-visible:ring-offset-1"
        >
          Book on 12Go
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      </div>
      <ul className="mt-2 space-y-1.5">
        {route.classes.map((c) => (
          <li key={c.label} className="text-[11px]">
            <span className="font-semibold text-[#374151]">{c.label}</span>
            {c.departures.length > 0 ? (
              <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
                {c.departures.slice(0, 10).map((t) => (
                  <span key={t} className="rounded bg-neutral-100 px-1.5 py-px font-mono text-[10px] tabular-nums text-[#374151]">
                    {t}
                  </span>
                ))}
                {c.departures.length > 10 && (
                  <span className="px-1 text-[10px] text-[#6B7280]">+{c.departures.length - 10} more</span>
                )}
              </span>
            ) : (
              <span className="ml-2 text-[#6B7280]">on request</span>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}

/**
 * Real transit directions (Google Routes) and the 12Go regional timetable for one leg. Fetched when
 * the leg is open (the server caches both for 7 days). The chosen transit route is drawn on the map.
 */
export function GroundSchedulePanel({ leg, fromStop, toStop, travellers, onOverlay }: GroundSchedulePanelProps) {
  const [data, setData] = useState<GroundSchedules | null>(null);
  const [open, setOpen] = useState(false);
  const [routeIdx, setRouteIdx] = useState(0);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({
      fromLat: String(fromStop.lat),
      fromLng: String(fromStop.lng),
      toLat: String(toStop.lat),
      toLng: String(toStop.lng),
      fromCity: fromStop.city,
      toCity: toStop.city,
      fromCountry: fromStop.country ?? '',
      toCountry: toStop.country ?? '',
      people: String(travellers),
    });
    if (leg.departureDate) params.set('date', leg.departureDate.slice(0, 10));
    fetch(`/api/ground/schedules?${params.toString()}`)
      .then((res) => (res.ok ? (res.json() as Promise<GroundSchedules>) : null))
      .then((body) => {
        if (active) {
          setData(body);
          setRouteIdx(0);
        }
      })
      .catch(() => {
        // the panel simply stays hidden
      });
    return () => {
      active = false;
    };
  }, [leg.id, leg.departureDate, fromStop.lat, fromStop.lng, fromStop.city, fromStop.country, toStop.lat, toStop.lng, toStop.city, toStop.country, travellers]);

  const transit = data?.google.routes ?? [];
  const timetable = data?.twelveGo.routes ?? [];
  const chosen = transit[Math.min(routeIdx, transit.length - 1)];
  const overlay = useMemo(() => (open && chosen ? routeToOverlay(chosen) : null), [open, chosen]);

  useEffect(() => {
    onOverlay(leg.id, overlay);
    return () => onOverlay(leg.id, null);
  }, [leg.id, overlay, onOverlay]);

  if (transit.length === 0 && timetable.length === 0) return null;

  return (
    <div className="rounded-xl border border-neutral-200/80 bg-neutral-50/60">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E]"
      >
        <span className="text-xs font-semibold text-[#111827]">
          Schedules &amp; transit directions
          <span className="ml-2 font-normal text-[#4B5563]">
            {[transit.length > 0 && `${transit.length} transit route${transit.length > 1 ? 's' : ''}`, timetable.length > 0 && `${timetable.length} on 12Go`]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        {open ? <ChevronUp className="h-4 w-4 shrink-0" aria-hidden="true" /> : <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />}
      </button>

      {open && (
        <div className="space-y-3 px-3 pb-3">
          {transit.length > 0 && chosen && (
            <section aria-label="Transit directions" className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {transit.map((r, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setRouteIdx(i)}
                    aria-pressed={i === routeIdx}
                    className={`cursor-pointer rounded-lg border px-2 py-1 text-[11px] font-semibold ${
                      i === routeIdx
                        ? 'border-[#FFD6BA] bg-[#FFF4ED] text-[#C2410C]'
                        : 'border-neutral-200 bg-white text-[#374151] hover:border-neutral-300'
                    }`}
                  >
                    {formatMinutes(r.durationMinutes)}
                    {r.fare && ` · ${r.fare.currency} ${r.fare.amount}`}
                  </button>
                ))}
              </div>
              <ol className="space-y-2 rounded-xl border border-neutral-200/80 bg-white p-2.5">
                {chosen.steps.map((s, i) => (
                  <StepRow key={i} step={s} />
                ))}
              </ol>
              <p className="text-[10px] text-[#6B7280]">
                Directions from Google Maps for the leg's date; check the operator before you travel.
              </p>
            </section>
          )}

          {timetable.length > 0 && (
            <section aria-label="12Go timetable" className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-[#4B5563]">12Go timetable</div>
              <ul className="space-y-2">
                {timetable.slice(0, 6).map((r) => (
                  <TwelveGoRow key={`${r.mode}-${r.from}-${r.to}`} route={r} />
                ))}
              </ul>
              <p className="text-[10px] text-[#6B7280]">
                Typical departures; 12Go does not list the operator here. Prices are per person.
              </p>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
