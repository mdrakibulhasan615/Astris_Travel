import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import greatCircle from '@turf/great-circle';
import { point } from '@turf/helpers';
import { BedDouble, Bus, LocateFixed, Plane, Ship, TrainFront } from 'lucide-react';
import { setWorkerUrl } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import Map, {
  Layer,
  Marker,
  NavigationControl,
  Popup,
  Source,
  type MapRef,
} from 'react-map-gl/maplibre';
import {
  anchorFlightSegments,
  ensureAirportConnectors,
  resolveAirport,
} from '../../shared/airports.ts';
import { groundGeometry } from '../../shared/groundRouting.ts';
import type { OverlayLine } from '../../shared/groundSchedule.ts';
import { formatDuration } from '../../shared/smartScore.ts';
import { SmartScoreBadge } from './SmartScoreBadge.tsx';
import type {
  ModeFilter,
  TransitMode,
  TransitSegment,
  TripLeg,
  TripStop,
} from '../../shared/types.ts';

setWorkerUrl(maplibreWorkerUrl);

interface WorldMapCanvasProps {
  /** Real transit routes (Google Routes) chosen in a leg's Schedules panel, keyed by leg id. */
  transitOverlays?: Record<string, OverlayLine[]>;
  /** Bumped by the route bar's Search button: frames the whole route again. */
  fitRouteTick?: number;
  stops: TripStop[];
  legs: TripLeg[];
  modeFilter: ModeFilter;
  hoveredStopId: string | null;
  hoveredLegId: string | null;
  activeLegId: string | null;
  focusTarget: { lat: number; lng: number; zoom?: number; ts: number } | null;
  onHoverStop: (stopId: string | null) => void;
  onSelectLeg: (legId: string) => void;
  /** Open the "Staying in [City]?" card for a stop. */
  onOpenStays: (stopId: string) => void;
}

const OPENFREEMAP_POSITRON_STYLE = 'https://tiles.openfreemap.org/styles/positron';

const FALLBACK_OSM_RASTER_STYLE = {
  version: 8 as const,
  sources: {
    osm: {
      type: 'raster' as const,
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    {
      id: 'osm-tiles',
      type: 'raster' as const,
      source: 'osm',
      minzoom: 0,
      maxzoom: 19,
    },
  ],
};

function getModeColor(mode: TransitMode): string {
  if (mode === 'flight') return '#FF812E';
  if (mode === 'train') return '#7C3AED';
  if (mode === 'bus') return '#0D9488';
  return '#0284C7';
}

function ModePillIcon({ mode }: { mode: TransitMode }) {
  const color = getModeColor(mode);
  if (mode === 'flight') return <Plane className="w-3.5 h-3.5 shrink-0" style={{ color }} />;
  if (mode === 'train') return <TrainFront className="w-3.5 h-3.5 shrink-0" style={{ color }} />;
  if (mode === 'bus') return <Bus className="w-3.5 h-3.5 shrink-0" style={{ color }} />;
  return <Ship className="w-3.5 h-3.5 shrink-0" style={{ color }} />;
}

function formatMinutesCompact(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function computeBearingDeg(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

interface PlaneBadge {
  id: string;
  lng: number;
  lat: number;
  bearingDeg: number;
  isHighlighted: boolean;
}

interface JunctionNode {
  id: string;
  lng: number;
  lat: number;
  name: string;
  mode: TransitMode;
}

/** Airport endpoint of a flight line; always sits exactly on the flight polyline's end point. */
interface AirportNode {
  id: string;
  code: string;
  lng: number;
  lat: number;
  name: string;
  isHighlighted: boolean;
}

interface MapCalloutItem {
  id: string;
  legId: string;
  stepNumber: number;
  mode: TransitMode;
  label: string;
  durationText: string;
  lng: number;
  lat: number;
  isHighlighted: boolean;
}

export function WorldMapCanvas({
  transitOverlays,
  fitRouteTick,
  stops,
  legs,
  modeFilter,
  hoveredStopId,
  hoveredLegId,
  activeLegId,
  focusTarget,
  onHoverStop,
  onSelectLeg,
  onOpenStays,
}: WorldMapCanvasProps) {
  const mapRef = useRef<MapRef | null>(null);

  // Real transit routes: one feature per step so each keeps its own colour and dash
  const transitGeoJson = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: Object.values(transitOverlays ?? {}).flatMap((lines) =>
        lines.map(
          (l): GeoJSON.Feature => ({
            type: 'Feature',
            properties: { kind: l.kind, color: l.color },
            geometry: { type: 'LineString', coordinates: l.coordinates },
          })
        )
      ),
    }),
    [transitOverlays]
  );
  // Bring a newly chosen transit route into view
  useEffect(() => {
    const coords = transitGeoJson.features.flatMap((f) =>
      f.geometry.type === 'LineString' ? f.geometry.coordinates : []
    );
    if (coords.length < 2) return;
    const lngs = coords.map((c) => c[0]);
    const lats = coords.map((c) => c[1]);
    mapRef.current?.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 70, maxZoom: 12, duration: 700 }
    );
  }, [transitGeoJson]);
  const [selectedPopupStop, setSelectedPopupStop] = useState<TripStop | null>(null);
  const [useFallbackStyle, setUseFallbackStyle] = useState(false);

  const highlightedLegId = hoveredLegId ?? activeLegId;

  // Build mode-specific GeoJSON layers, plane markers, station dots, junction nodes, and floating callouts
  const mapLayersData = useMemo(() => {
    const stopById: Record<string, TripStop> = {};
    for (const stop of stops) {
      stopById[stop.id] = stop;
    }

    const flightFeatures: GeoJSON.Feature[] = [];
    const trainFeatures: GeoJSON.Feature[] = [];
    const busFeatures: GeoJSON.Feature[] = [];
    // Legs with no fares yet: a plain dashed line between the two stops (no route or mode is implied)
    const plainFeatures: GeoJSON.Feature[] = [];
    // Ground legs that connect a city/station to an airport node. Kept in their own source so they
    // are drawn as distinct dashed connectors and never merge into the flight line.
    const connectorFeatures: GeoJSON.Feature[] = [];
    // (plain record: `Map` is shadowed by the react-map-gl import)
    const airportNodeMap: Record<string, AirportNode> = {};
    const stationDotFeatures: GeoJSON.Feature[] = [];
    const planeBadges: PlaneBadge[] = [];
    const junctionNodes: JunctionNode[] = [];
    const callouts: MapCalloutItem[] = [];

    const stopIdsSet = new Set(stops.map((s) => `${s.lat.toFixed(3)},${s.lng.toFixed(3)}`));

    legs.forEach((leg, legIndex) => {
      const fromStop = stopById[leg.fromStopId];
      const toStop = stopById[leg.toStopId];
      if (!fromStop || !toStop) return;

      const isHighlighted =
        leg.id === highlightedLegId ||
        (hoveredStopId !== null &&
          (leg.fromStopId === hoveredStopId || leg.toStopId === hoveredStopId));

      // Respect floating mode filter on map: pick selected option if it matches, else best matching mode option
      const selectedOption =
        leg.transitOptions.find((o) => o.id === leg.selectedOptionId) ??
        leg.transitOptions[0];
      const displayOption =
        modeFilter === 'all' || selectedOption?.mode === modeFilter
          ? selectedOption
          : leg.transitOptions.find((o) => o.mode === modeFilter) ?? selectedOption;

      if (!displayOption) {
        try {
          const arc = greatCircle(point([fromStop.lng, fromStop.lat]), point([toStop.lng, toStop.lat]), { npoints: 72 });
          plainFeatures.push({ ...arc, properties: { legId: leg.id, isHighlighted } });
        } catch {
          /* two identical points: nothing to draw */
        }
        return;
      }

      // Flight fallback (no segment data): anchor to the leg's airports, not the city centres
      const fallbackFrom =
        displayOption.mode === 'flight' ? resolveAirport(leg.fromCode) : null;
      const fallbackTo = displayOption.mode === 'flight' ? resolveAirport(leg.toCode) : null;

      const rawSegments: TransitSegment[] =
        displayOption.segments && displayOption.segments.length > 0
          ? displayOption.segments
          : [
              {
                id: `${leg.id}-fallback`,
                mode: displayOption.mode,
                label: displayOption.routeCode,
                fromName: fallbackFrom?.name ?? leg.fromCity,
                fromCode: fallbackFrom?.code ?? leg.fromCode,
                fromLat: fallbackFrom?.lat ?? fromStop.lat,
                fromLng: fallbackFrom?.lng ?? fromStop.lng,
                toName: fallbackTo?.name ?? leg.toCity,
                toCode: fallbackTo?.code ?? leg.toCode,
                toLat: fallbackTo?.lat ?? toStop.lat,
                toLng: fallbackTo?.lng ?? toStop.lng,
                durationMinutes: Math.round(displayOption.inVehicleHours * 60),
              },
            ];

      // Strict airport anchoring + separate ground connectors (idempotent with server-side data)
      const segments: TransitSegment[] = ensureAirportConnectors(
        anchorFlightSegments(rawSegments),
        fromStop,
        toStop,
        displayOption.id
      );

      // Primary segment for leg callout placement
      let primarySegment = segments[0];
      for (const seg of segments) {
        if (seg.durationMinutes > primarySegment.durationMinutes) {
          primarySegment = seg;
        }
      }

      segments.forEach((seg, segIdx) => {
        // Junction node at intermediate transfer points (not matching main numbered stop pins)
        if (segIdx > 0 && seg.mode !== 'flight') {
          const key = `${seg.fromLat.toFixed(3)},${seg.fromLng.toFixed(3)}`;
          if (!stopIdsSet.has(key)) {
            junctionNodes.push({
              id: `${seg.id}-junc`,
              lng: seg.fromLng,
              lat: seg.fromLat,
              name: seg.fromName,
              mode: seg.mode,
            });
          }
        }

        if (seg.mode === 'flight') {
          for (const end of [
            { code: seg.fromCode, name: seg.fromName, lat: seg.fromLat, lng: seg.fromLng },
            { code: seg.toCode, name: seg.toName, lat: seg.toLat, lng: seg.toLng },
          ]) {
            const prev = airportNodeMap[end.code];
            if (!prev || (isHighlighted && !prev.isHighlighted)) {
              airportNodeMap[end.code] = {
                id: `airport-${end.code}`,
                code: end.code,
                lng: end.lng,
                lat: end.lat,
                name: end.name,
                isHighlighted,
              };
            }
          }
          try {
            const arc = greatCircle(
              point([seg.fromLng, seg.fromLat]),
              point([seg.toLng, seg.toLat]),
              { npoints: 72 }
            );
            flightFeatures.push({
              ...arc,
              properties: {
                legId: leg.id,
                segId: seg.id,
                isHighlighted,
              },
            });

            // Compute midpoint + bearing for directional plane icon and callout placement
            const geom = arc.geometry;
            const coords =
              geom.type === 'LineString' ? geom.coordinates : geom.coordinates[0] ?? [];
            if (coords.length >= 3) {
              const midIdx = Math.floor(coords.length / 2);
              const prevPt = coords[Math.max(0, midIdx - 1)];
              const midPt = coords[midIdx];
              const nextPt = coords[Math.min(coords.length - 1, midIdx + 1)];
              const bearingDeg = computeBearingDeg(prevPt[0], prevPt[1], nextPt[0], nextPt[1]);

              planeBadges.push({
                id: `${seg.id}-plane`,
                lng: midPt[0],
                lat: midPt[1],
                bearingDeg,
                isHighlighted,
              });

              if (seg.id === primarySegment.id) {
                callouts.push({
                  id: `${leg.id}-callout`,
                  legId: leg.id,
                  stepNumber: legIndex + 1,
                  mode: seg.mode,
                  label: `${seg.fromCode} → ${seg.toCode}`,
                  durationText: formatMinutesCompact(seg.durationMinutes),
                  lng: midPt[0],
                  lat: midPt[1],
                  isHighlighted,
                });
              }
            }
          } catch {
            // Skip malformed segment
          }
        } else {
          // A ground segment is a connector when it leads to the next flight's departure airport
          // or comes from the previous flight's arrival airport.
          const prevSeg = segments[segIdx - 1];
          const nextSeg = segments[segIdx + 1];
          const isConnector =
            (nextSeg?.mode === 'flight' && nextSeg.fromCode === seg.toCode) ||
            (prevSeg?.mode === 'flight' && prevSeg.toCode === seg.fromCode);

          // Ground legs follow the land network and are smoothed through their stations
          // (shared/groundRouting.ts) rather than drawn as a chord across sea or mountains.
          const { coordinates: lineCoords, stations } = groundGeometry(seg, { isConnector });

          const lineFeature: GeoJSON.Feature = {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: lineCoords,
            },
            properties: {
              legId: leg.id,
              segId: seg.id,
              isHighlighted,
            },
          };

          if (isConnector) {
            connectorFeatures.push({
              ...lineFeature,
              properties: { ...lineFeature.properties, color: getModeColor(seg.mode) },
            });
          } else if (seg.mode === 'train') {
            trainFeatures.push(lineFeature);
          } else {
            busFeatures.push(lineFeature);
          }

          // Intermediate station / stop dots along ground polylines
          for (const station of stations) {
            stationDotFeatures.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: station },
              properties: { mode: seg.mode, color: getModeColor(seg.mode) },
            });
          }

          if (seg.id === primarySegment.id) {
            const midCoord = lineCoords[Math.floor(lineCoords.length / 2)];
            callouts.push({
              id: `${leg.id}-callout`,
              legId: leg.id,
              stepNumber: legIndex + 1,
              mode: seg.mode,
              label: seg.label,
              durationText: formatMinutesCompact(seg.durationMinutes),
              lng: midCoord[0],
              lat: midCoord[1],
              isHighlighted,
            });
          }
        }
      });

      // If leg is highlighted and starts with a local transfer rail/bus segment, show its callout too
      if (isHighlighted && segments.length > 1 && segments[0].id !== primarySegment.id) {
        const first = segments[0];
        callouts.push({
          id: `${leg.id}-transfer-callout`,
          legId: leg.id,
          stepNumber: legIndex + 1,
          mode: first.mode,
          label: first.label,
          durationText: formatMinutesCompact(first.durationMinutes),
          lng: (first.fromLng + first.toLng) / 2,
          lat: (first.fromLat + first.toLat) / 2,
          isHighlighted: true,
        });
      }
    });

    return {
      flightGeoJson: { type: 'FeatureCollection' as const, features: flightFeatures },
      trainGeoJson: { type: 'FeatureCollection' as const, features: trainFeatures },
      busGeoJson: { type: 'FeatureCollection' as const, features: busFeatures },
      plainGeoJson: { type: 'FeatureCollection' as const, features: plainFeatures },
      connectorGeoJson: { type: 'FeatureCollection' as const, features: connectorFeatures },
      airportNodes: Object.values(airportNodeMap),
      stationDotsGeoJson: { type: 'FeatureCollection' as const, features: stationDotFeatures },
      planeBadges,
      junctionNodes,
      callouts,
    };
  }, [stops, legs, modeFilter, highlightedLegId, hoveredStopId]);

  const fitAllStops = useCallback(() => {
    const map = mapRef.current;
    if (!map || stops.length === 0) return;

    if (stops.length === 1) {
      map.flyTo({
        center: [stops[0].lng, stops[0].lat],
        zoom: 5,
        duration: 650,
      });
      return;
    }

    let minLng = Infinity;
    let maxLng = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;

    for (const s of stops) {
      if (s.lng < minLng) minLng = s.lng;
      if (s.lng > maxLng) maxLng = s.lng;
      if (s.lat < minLat) minLat = s.lat;
      if (s.lat > maxLat) maxLat = s.lat;
    }

    map.fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      {
        padding: { top: 96, bottom: 110, left: 75, right: 75 },
        duration: 750,
        maxZoom: 6.2,
      }
    );
  }, [stops]);

  const stopKey = stops.map((s) => s.id).join('>');
  useEffect(() => {
    const timer = setTimeout(() => {
      fitAllStops();
    }, 120);
    return () => clearTimeout(timer);
  }, [stopKey, fitAllStops]);

  useEffect(() => {
    if (!focusTarget || !mapRef.current) return;
    mapRef.current.flyTo({
      center: [focusTarget.lng, focusTarget.lat],
      zoom: focusTarget.zoom ?? 4.8,
      duration: 650,
    });
  }, [focusTarget]);

  // Search (route bar) re-frames the route; the first render is handled by the effect above
  const lastFitTick = useRef(fitRouteTick);
  useEffect(() => {
    if (fitRouteTick === lastFitTick.current) return;
    lastFitTick.current = fitRouteTick;
    fitAllStops();
  }, [fitRouteTick, fitAllStops]);

  // A place can be in the trip more than once (A → B → A). Its visits share one pin that lists
  // every stop number, instead of stacking pins that hide each other.
  const stopPins = useMemo(() => {
    const pins: { key: string; lat: number; lng: number; visits: { stop: TripStop; index: number }[] }[] = [];
    stops.forEach((stop, index) => {
      const key = `${stop.lat.toFixed(3)},${stop.lng.toFixed(3)}`;
      const pin = pins.find((p) => p.key === key);
      if (pin) pin.visits.push({ stop, index });
      else pins.push({ key, lat: stop.lat, lng: stop.lng, visits: [{ stop, index }] });
    });
    return pins;
  }, [stops]);

  const activeLeg = legs.find((l) => l.id === highlightedLegId) ?? legs[0] ?? null;
  const activeLegSelectedOption = activeLeg
    ? activeLeg.transitOptions.find((o) => o.id === activeLeg.selectedOptionId) ??
      activeLeg.transitOptions[0]
    : null;

  return (
    <div className="relative w-full h-full min-h-[420px] bg-[#EBF1F5]">
      <Map
        ref={mapRef}
        workerUrl={maplibreWorkerUrl}
        initialViewState={{
          longitude: 42,
          latitude: 34,
          zoom: 2.3,
        }}
        mapStyle={useFallbackStyle ? FALLBACK_OSM_RASTER_STYLE : OPENFREEMAP_POSITRON_STYLE}
        onError={() => {
          if (!useFallbackStyle) setUseFallbackStyle(true);
        }}
        attributionControl={false}
        style={{ width: '100%', height: '100%' }}
      >
        <NavigationControl position="bottom-right" showCompass={false} />

        {/* 0. Legs with no fares yet: a plain dashed line between the stops */}
        <Source id="astris-plain-lines" type="geojson" data={mapLayersData.plainGeoJson}>
          <Layer
            id="astris-plain-line"
            type="line"
            paint={{
              'line-color': ['case', ['boolean', ['get', 'isHighlighted'], false], '#4B5563', '#9CA3AF'],
              'line-width': 2.5,
              'line-dasharray': [2, 2],
              'line-opacity': 0.9,
            }}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          />
        </Source>

        {/* 1. Trains: Purple (#7C3AED) multi-point rail polylines (the same purple as train tickets) */}
        <Source id="astris-train-lines" type="geojson" data={mapLayersData.trainGeoJson}>
          <Layer
            id="astris-train-casing"
            type="line"
            paint={{
              'line-color': '#FFFFFF',
              'line-width': ['case', ['boolean', ['get', 'isHighlighted'], false], 6.5, 5],
              'line-opacity': 0.9,
            }}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          />
          <Layer
            id="astris-train-stroke"
            type="line"
            paint={{
              'line-color': '#7C3AED',
              'line-width': ['case', ['boolean', ['get', 'isHighlighted'], false], 4, 3],
              'line-opacity': 0.95,
            }}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          />
        </Source>

        {/* 2. Buses & Local Ground Transfers: Teal (#0D9488) polylines */}
        <Source id="astris-bus-lines" type="geojson" data={mapLayersData.busGeoJson}>
          <Layer
            id="astris-bus-casing"
            type="line"
            paint={{
              'line-color': '#FFFFFF',
              'line-width': ['case', ['boolean', ['get', 'isHighlighted'], false], 6.5, 5],
              'line-opacity': 0.9,
            }}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          />
          <Layer
            id="astris-bus-stroke"
            type="line"
            paint={{
              'line-color': '#0D9488',
              'line-width': ['case', ['boolean', ['get', 'isHighlighted'], false], 4, 3],
              'line-opacity': 0.95,
            }}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          />
        </Source>

        {/* 2b. Airport connectors (metro / express rail / coach to or from an airport): dashed,
            separate from the flight arc so the flight line stays airport-to-airport. */}
        <Source id="astris-connector-lines" type="geojson" data={mapLayersData.connectorGeoJson}>
          <Layer
            id="astris-connector-casing"
            type="line"
            paint={{
              'line-color': '#FFFFFF',
              'line-width': ['case', ['boolean', ['get', 'isHighlighted'], false], 5.5, 4],
              'line-opacity': 0.9,
            }}
            layout={{ 'line-cap': 'butt', 'line-join': 'round' }}
          />
          <Layer
            id="astris-connector-stroke"
            type="line"
            paint={{
              'line-color': ['get', 'color'],
              'line-width': ['case', ['boolean', ['get', 'isHighlighted'], false], 3, 2.2],
              'line-opacity': 0.95,
              'line-dasharray': [1.6, 1.6],
            }}
            layout={{ 'line-cap': 'butt', 'line-join': 'round' }}
          />
        </Source>

        {/* 2c. Real transit route chosen in a leg's Schedules panel (Google Routes):
            trains solid blue, metro and trams dashed blue, buses orange, walking dotted grey. */}
        <Source id="astris-transit-overlay" type="geojson" data={transitGeoJson}>
          <Layer
            id="astris-transit-casing"
            type="line"
            filter={['!=', ['get', 'kind'], 'walk']}
            paint={{ 'line-color': '#FFFFFF', 'line-width': 7, 'line-opacity': 0.95 }}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          />
          <Layer
            id="astris-transit-solid"
            type="line"
            filter={['in', ['get', 'kind'], ['literal', ['rail', 'bus']]]}
            paint={{ 'line-color': ['get', 'color'], 'line-width': 4.5 }}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          />
          <Layer
            id="astris-transit-dashed"
            type="line"
            filter={['==', ['get', 'kind'], 'subway']}
            paint={{ 'line-color': ['get', 'color'], 'line-width': 4.5, 'line-dasharray': [2, 1.4] }}
            layout={{ 'line-cap': 'butt', 'line-join': 'round' }}
          />
          <Layer
            id="astris-transit-walk"
            type="line"
            filter={['==', ['get', 'kind'], 'walk']}
            paint={{ 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-dasharray': [0.4, 1.6] }}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          />
        </Source>

        {/* 3. Intermediate Station / Stop Dots along Train & Bus Polylines */}
        <Source id="astris-station-dots" type="geojson" data={mapLayersData.stationDotsGeoJson}>
          <Layer
            id="astris-station-dots-layer"
            type="circle"
            paint={{
              'circle-radius': 4,
              'circle-color': ['get', 'color'],
              'circle-stroke-color': '#FFFFFF',
              'circle-stroke-width': 1.5,
            }}
          />
        </Source>

        {/* 4. Flights: Sweeping Sunset Orange (#FF812E) great-circle arcs (3px base) */}
        <Source id="astris-flight-arcs" type="geojson" data={mapLayersData.flightGeoJson}>
          <Layer
            id="astris-flight-casing"
            type="line"
            paint={{
              'line-color': '#FFFFFF',
              'line-width': ['case', ['boolean', ['get', 'isHighlighted'], false], 6.5, 5],
              'line-opacity': 0.85,
            }}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          />
          <Layer
            id="astris-flight-stroke"
            type="line"
            paint={{
              'line-color': '#FF812E',
              'line-width': ['case', ['boolean', ['get', 'isHighlighted'], false], 4.2, 3],
              'line-opacity': ['case', ['boolean', ['get', 'isHighlighted'], false], 1, 0.88],
            }}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          />
        </Source>

        {/* Directional Airplane Icons along Flight Arcs */}
        {mapLayersData.planeBadges.map((plane) => (
          <Marker
            key={plane.id}
            longitude={plane.lng}
            latitude={plane.lat}
            anchor="center"
          >
            <div
              className={`w-6 h-6 rounded-full bg-white border border-[#FFD6BA] shadow-sm flex items-center justify-center pointer-events-none transition-transform ${
                plane.isHighlighted ? 'scale-115' : 'scale-100'
              }`}
              style={{
                transform: `rotate(${plane.bearingDeg - 45}deg)`,
              }}
            >
              <Plane className="w-3.5 h-3.5 text-[#FF812E] fill-[#FF812E]" />
            </div>
          </Marker>
        ))}

        {/* 8px White-Bordered Junction Nodes at Airport / Transfer Points */}
        {mapLayersData.junctionNodes.map((node) => (
          <Marker
            key={node.id}
            longitude={node.lng}
            latitude={node.lat}
            anchor="center"
          >
            <div
              title={node.name}
              className="w-2.5 h-2.5 rounded-full border-2 border-white shadow-sm"
              style={{ backgroundColor: getModeColor(node.mode) }}
            />
          </Marker>
        ))}

        {/* Airport nodes: exact flight-line endpoints, labelled with the airport IATA code */}
        {mapLayersData.airportNodes.map((node) => (
          <Marker key={node.id} longitude={node.lng} latitude={node.lat} anchor="center">
            <div
              title={node.name}
              className={`pointer-events-none flex items-center gap-0.5 rounded-full border-2 bg-white px-1 py-px shadow-sm ${
                node.isHighlighted ? 'border-[#E56B1A]' : 'border-[#FF812E]'
              }`}
            >
              <Plane className="h-2.5 w-2.5 text-[#FF812E]" aria-hidden="true" />
              <span className="font-mono text-[9px] font-bold leading-none text-[#111827]">
                {node.code}
              </span>
            </div>
          </Marker>
        ))}

        {/* Floating White Callout Cards near Key Hubs / Legs */}
        {mapLayersData.callouts.map((callout) => (
          <Marker
            key={callout.id}
            longitude={callout.lng}
            latitude={callout.lat}
            anchor="bottom"
            offset={[0, -10]}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSelectLeg(callout.legId);
              }}
              className={`inline-flex items-center gap-1.5 bg-white/95 backdrop-blur-sm shadow-md rounded-xl px-2.5 py-1 border text-[11px] font-medium whitespace-nowrap transition-transform cursor-pointer ${
                callout.isHighlighted
                  ? 'border-[#FFD6BA] ring-2 ring-[#FF812E]/20 scale-105 text-[#111827]'
                  : 'border-slate-200/80 text-[#111827] hover:scale-105'
              }`}
            >
              <span className="font-mono font-semibold text-[#4B5563]">
                {callout.stepNumber}
              </span>
              <ModePillIcon mode={callout.mode} />
              <span className="font-semibold">{callout.label}</span>
              <span className="text-neutral-300" aria-hidden="true">
                ·
              </span>
              <span className="font-mono text-[#4B5563] tabular-nums">
                {callout.durationText}
              </span>
            </button>
          </Marker>
        ))}

        {/* Numbered Destination Pins (1, 2, 3, 4...) in #FF812E with white halo */}
        {stopPins.map((pin) => {
          const stop = pin.visits[0].stop;
          const isHovered = pin.visits.some((v) => v.stop.id === hoveredStopId);
          const label = pin.visits.map((v) => v.index + 1).join('·');
          const isShared = pin.visits.length > 1;
          return (
            <Marker
              key={pin.key}
              longitude={pin.lng}
              latitude={pin.lat}
              anchor="center"
            >
              <button
                type="button"
                aria-label={`Stop ${pin.visits.map((v) => v.index + 1).join(' and ')}: ${stop.city}`}
                onMouseEnter={() => onHoverStop(stop.id)}
                onMouseLeave={() => onHoverStop(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedPopupStop(stop);
                  const relatedLeg = legs.find(
                    (l) => l.fromStopId === stop.id || l.toStopId === stop.id
                  );
                  if (relatedLeg) onSelectLeg(relatedLeg.id);
                }}
                className={`group relative flex items-center justify-center rounded-full font-display font-bold text-white transition-transform duration-150 cursor-pointer ring-4 ring-white shadow-lg focus-visible:outline-none ${
                  isShared ? 'px-2.5 min-w-8' : isHovered ? 'w-9' : 'w-8'
                } ${
                  isHovered
                    ? 'h-9 bg-[#E56B1A] scale-115 text-sm z-30'
                    : 'h-8 bg-[#FF812E] hover:bg-[#E56B1A] hover:scale-110 text-xs z-20'
                }`}
              >
                {label}
                <span className="pointer-events-none absolute -bottom-7 left-1/2 -translate-x-1/2 whitespace-nowrap px-2 py-0.5 rounded-md bg-white/95 text-[#111827] text-[11px] font-semibold shadow-sm border border-neutral-200/80 opacity-0 group-hover:opacity-100 transition-opacity">
                  {stop.city}
                </span>
              </button>
            </Marker>
          );
        })}

        {selectedPopupStop && (
          <Popup
            longitude={selectedPopupStop.lng}
            latitude={selectedPopupStop.lat}
            anchor="top"
            offset={16}
            onClose={() => setSelectedPopupStop(null)}
          >
            <div className="space-y-1 min-w-[150px]">
              <div className="font-display font-bold text-sm text-[#111827]">
                {selectedPopupStop.order}. {selectedPopupStop.city}
              </div>
              <div className="text-xs text-[#4B5563]">
                {selectedPopupStop.country} ·{' '}
                <span className="font-mono">{selectedPopupStop.iataCode}</span>
              </div>
              {stops[0]?.id === selectedPopupStop.id ? (
                <div className="text-xs font-mono text-[#E56B1A] tabular-nums">
                  Trip start · departs {selectedPopupStop.departureDate}
                </div>
              ) : (
                <>
                  <div className="text-xs font-mono text-[#E56B1A] tabular-nums">
                    {selectedPopupStop.stayNights}n · {selectedPopupStop.arrivalDate}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      onOpenStays(selectedPopupStop.id);
                      setSelectedPopupStop(null);
                    }}
                    className="mt-1 inline-flex items-center gap-1 rounded-lg bg-[#FF812E] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#E56B1A] cursor-pointer"
                  >
                    <BedDouble className="h-3 w-3" aria-hidden="true" />
                    Find stays in {selectedPopupStop.city}
                  </button>
                </>
              )}
            </div>
          </Popup>
        )}
      </Map>

      {/* Bottom Floating Mode Legend + Active Corridor Telemetry + Fit Route */}
      <div className="absolute bottom-4 left-4 right-14 z-20 flex flex-wrap items-end justify-between gap-3 pointer-events-none">
        {activeLeg && activeLegSelectedOption && (
          <div className="pointer-events-auto bg-white/95 backdrop-blur-md border border-slate-200/80 shadow-md rounded-2xl px-3.5 py-2.5 max-w-md space-y-1">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#111827]">
              <span>
                {activeLeg.fromCode} → {activeLeg.toCode}
              </span>
              <span className="font-mono text-[#4B5563] font-normal tabular-nums">
                {activeLeg.distanceKm.toLocaleString()} km
              </span>
              <SmartScoreBadge score={activeLegSelectedOption.smartScore} size="sm" />
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#4B5563] tabular-nums">
              <span className="font-medium text-[#111827]">
                {activeLegSelectedOption.carrier} ·{' '}
                {formatDuration(
                  activeLegSelectedOption.inVehicleHours + activeLegSelectedOption.layoverHours
                )}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-0.5 bg-[#FF812E] rounded-full" />
                Flight
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-0.5 bg-[#7C3AED] rounded-full" />
                Rail
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-0.5 bg-[#0D9488] rounded-full" />
                Bus
              </span>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={fitAllStops}
          className="pointer-events-auto inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-white/95 backdrop-blur-md border border-slate-200/80 shadow-md text-xs font-semibold text-[#111827] hover:bg-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <LocateFixed className="w-3.5 h-3.5 text-[#FF812E]" />
          <span>Fit Route</span>
        </button>
      </div>
    </div>
  );
}
