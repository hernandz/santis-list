"use client";

import "leaflet/dist/leaflet.css";
import { MapContainer, TileLayer, GeoJSON } from "react-leaflet";
import { useMemo } from "react";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { PathOptions } from "leaflet";

export type BoundaryData = { name: string; geometry: Geometry; region: string | null };

const CITY_CENTERS: Record<string, [number, number]> = {
  newyork: [40.7128, -73.935],
  sfbay: [37.8, -122.27],
  losangeles: [34.05, -118.35],
};

// CARTO Positron — a flatter, lower-contrast basemap than stock OSM tiles;
// free, no API key required.
const TILE_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

export function NeighborhoodMapPicker({
  city,
  boundaries,
  selected,
  onToggle,
}: {
  city: string;
  boundaries: BoundaryData[];
  selected: string[];
  onToggle: (name: string) => void;
}) {
  const featureCollection = useMemo<FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: boundaries.map((b) => ({
        type: "Feature",
        properties: { name: b.name },
        geometry: b.geometry,
      })),
    }),
    [boundaries],
  );

  const center = CITY_CENTERS[city] ?? CITY_CENTERS.newyork;

  function styleFor(feature?: Feature): PathOptions {
    const name = feature?.properties?.name as string | undefined;
    const isSelected = name != null && selected.includes(name);
    return isSelected
      ? { color: "#2563eb", weight: 2, fillColor: "#2563eb", fillOpacity: 0.35 }
      : { color: "#6b7280", weight: 1, fillColor: "#6b7280", fillOpacity: 0.05 };
  }

  return (
    <div className="h-[32rem] w-full rounded-lg overflow-hidden border border-black/10 dark:border-white/15">
      <MapContainer center={center} zoom={11} scrollWheelZoom={false} className="h-full w-full z-0">
        <TileLayer attribution={TILE_ATTRIBUTION} url={TILE_URL} />
        {boundaries.length > 0 && (
          <GeoJSON
            key={`${city}-${boundaries.length}-${selected.join(",")}`}
            data={featureCollection}
            style={styleFor}
            onEachFeature={(feature, layer) => {
              const name = feature.properties?.name as string | undefined;
              if (!name) return;
              layer.bindTooltip(name, { sticky: true });
              layer.on("click", () => onToggle(name));
            }}
          />
        )}
      </MapContainer>
    </div>
  );
}
