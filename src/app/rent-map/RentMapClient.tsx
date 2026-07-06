"use client";

import "leaflet/dist/leaflet.css";
import { MapContainer, TileLayer, GeoJSON, useMap } from "react-leaflet";
import { useEffect, useMemo, useState } from "react";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { PathOptions } from "leaflet";

type NeighborhoodRent = {
  name: string;
  geometry: Geometry;
  region: string | null;
  median: number;
  min: number;
  max: number;
  count: number;
};

const CITY_CENTERS: Record<string, [number, number]> = {
  newyork: [40.7128, -73.935],
  sfbay: [37.8, -122.27],
  losangeles: [34.05, -118.35],
};

const TILE_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

function RecenterOnCityChange({ center }: { center: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, 11);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center[0], center[1], map]);
  return null;
}

function hueColor(hue: number): string {
  return `hsl(${hue}, 75%, 50%)`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Same green-at-min/yellow-at-median/red-at-max scaling as the per-listing
// price coloring on the feed (see medianRelativeColor in app/page.tsx), just
// applied one level up: here the "listings" being compared are neighborhood
// medians, not individual prices, so the reference points are the min/
// median/max *of those medians* across every neighborhood shown on this map.
function fillColorFor(value: number, lo: number, mid: number, hi: number): string {
  if (lo === hi) return hueColor(60);
  let t: number;
  if (value <= mid) {
    t = mid === lo ? 0 : (value - mid) / (mid - lo);
  } else {
    t = hi === mid ? 0 : (value - mid) / (hi - mid);
  }
  t = Math.min(1, Math.max(-1, t));
  return hueColor(60 - t * 60);
}

export function RentMapClient({ city, bedrooms }: { city: string; bedrooms: string }) {
  const [neighborhoods, setNeighborhoods] = useState<NeighborhoodRent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/rent-map?city=${encodeURIComponent(city)}&bedrooms=${encodeURIComponent(bedrooms)}`,
          { cache: "no-store" },
        );
        const body = await res.json();
        if (!cancelled) setNeighborhoods(body.neighborhoods ?? []);
      } catch {
        if (!cancelled) setNeighborhoods([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [city, bedrooms]);

  const { lo, mid, hi } = useMemo(() => {
    if (neighborhoods.length === 0) return { lo: 0, mid: 0, hi: 0 };
    const medians = neighborhoods.map((n) => n.median);
    return { lo: Math.min(...medians), mid: median(medians), hi: Math.max(...medians) };
  }, [neighborhoods]);

  const featureCollection = useMemo<FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: neighborhoods.map((n) => ({
        type: "Feature",
        properties: { name: n.name, median: n.median, min: n.min, max: n.max, count: n.count },
        geometry: n.geometry,
      })),
    }),
    [neighborhoods],
  );

  const center = CITY_CENTERS[city] ?? CITY_CENTERS.newyork;

  function styleFor(feature?: Feature): PathOptions {
    const m = feature?.properties?.median as number | undefined;
    if (m == null) return { color: "#6b7280", weight: 1, fillOpacity: 0 };
    const fill = fillColorFor(m, lo, mid, hi);
    return { color: "#00000033", weight: 1, fillColor: fill, fillOpacity: 0.55 };
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="h-[36rem] w-full rounded-lg overflow-hidden border border-black/10 dark:border-white/15 relative">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 text-sm">
            Loading…
          </div>
        )}
        {!loading && neighborhoods.length === 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 text-sm text-black/50 dark:text-white/50 px-6 text-center">
            No listings with a verified neighborhood for this city/bedroom count yet.
          </div>
        )}
        <MapContainer center={center} zoom={11} scrollWheelZoom={false} className="h-full w-full z-0">
          <RecenterOnCityChange center={center} />
          <TileLayer attribution={TILE_ATTRIBUTION} url={TILE_URL} />
          {neighborhoods.length > 0 && (
            <GeoJSON
              key={`${city}-${bedrooms}-${neighborhoods.length}`}
              data={featureCollection}
              style={styleFor}
              onEachFeature={(feature, layer) => {
                const p = feature.properties as { name: string; median: number; min: number; max: number; count: number };
                layer.bindTooltip(
                  `${p.name}<br/>Median: $${Math.round(p.median).toLocaleString()}<br/>Range: $${Math.round(p.min).toLocaleString()}–$${Math.round(p.max).toLocaleString()}<br/>${p.count} listing${p.count === 1 ? "" : "s"}`,
                  { sticky: true },
                );
              }}
            />
          )}
        </MapContainer>
      </div>
      {neighborhoods.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-black/60 dark:text-white/60">
          <span>Cheapest: ${Math.round(lo).toLocaleString()}</span>
          <span
            className="inline-block w-32 h-2 rounded"
            style={{ background: "linear-gradient(to right, hsl(120,75%,50%), hsl(60,75%,50%), hsl(0,75%,50%))" }}
          />
          <span>Priciest: ${Math.round(hi).toLocaleString()}</span>
          <span className="ml-2">Median of medians: ${Math.round(mid).toLocaleString()}</span>
        </div>
      )}
    </div>
  );
}
