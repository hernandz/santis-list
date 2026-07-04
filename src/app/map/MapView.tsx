"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { MapContainer, TileLayer, Marker, Popup, GeoJSON } from "react-leaflet";
import { useMemo } from "react";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { PathOptions } from "leaflet";
import { TrainLineBadge, type TransitLine } from "@/components/TrainLineBadge";

type NearestStationInfo = { name: string; lines: TransitLine[]; distanceMiles: number; walkingMinutes: number };

export type MapListing = {
  id: string;
  title: string;
  url: string;
  price: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  latitude: number;
  longitude: number;
  locationText: string | null;
  boundaryNeighborhood: string | null;
  nearestStation: NearestStationInfo | null;
  nextStation: NearestStationInfo | null;
};

export type MapStation = { name: string; lines: TransitLine[]; latitude: number; longitude: number };
export type MapBoundary = { name: string; geometry: Geometry };

const CITY_CENTERS: Record<string, [number, number]> = {
  newyork: [40.7128, -73.935],
  sfbay: [37.8, -122.27],
  losangeles: [34.05, -118.35],
};

// Deliberately saturated, high-contrast colors — the CARTO Positron basemap
// is intentionally pale/low-contrast (that's what makes it "basic"), so
// markers need real brand-saturated colors to still read clearly against it.
const markerIcon = L.divIcon({
  className: "",
  html: '<div style="width:14px;height:14px;border-radius:9999px;background:#dc2626;border:2px solid white;box-shadow:0 0 0 1px rgba(0,0,0,0.4)"></div>',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

// Each line gets an equal wedge of a conic-gradient "pie", using that line's
// own official color. Deliberately smaller, no white outline, and partly
// transparent — there can be hundreds of these (they don't change with the
// search scope), so they need to read as background context, clearly
// distinct from the small number of solid, opaque listing markers.
function stationIcon(lines: TransitLine[]): L.DivIcon {
  const colors = lines.length > 0 ? lines.map((l) => l.color) : ["#374151"];
  const step = 100 / colors.length;
  const stops = colors.map((c, i) => `${c} ${i * step}% ${(i + 1) * step}%`).join(", ");
  return L.divIcon({
    className: "",
    html: `<div style="width:9px;height:9px;border-radius:9999px;background:conic-gradient(${stops});opacity:0.6;border:1px solid rgba(255,255,255,0.7)"></div>`,
    iconSize: [9, 9],
    iconAnchor: [4, 4],
  });
}

export function MapView({
  listings,
  city,
  stations = [],
  boundaries = [],
  highlightNeighborhoods = [],
  showStations = true,
}: {
  listings: MapListing[];
  city: string;
  stations?: MapStation[];
  boundaries?: MapBoundary[];
  highlightNeighborhoods?: string[];
  showStations?: boolean;
}) {
  const center = useMemo(() => CITY_CENTERS[city] ?? CITY_CENTERS.newyork, [city]);

  const highlightCollection = useMemo<FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: boundaries
        .filter((b) => highlightNeighborhoods.includes(b.name))
        .map((b) => ({ type: "Feature", properties: { name: b.name }, geometry: b.geometry })),
    }),
    [boundaries, highlightNeighborhoods],
  );

  function highlightStyle(): PathOptions {
    return { color: "#2563eb", weight: 2, fillColor: "#2563eb", fillOpacity: 0.15 };
  }

  return (
    <MapContainer center={center} zoom={12} scrollWheelZoom className="h-[70vh] w-full rounded-lg z-0">
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
      />
      {highlightNeighborhoods.length > 0 && highlightCollection.features.length > 0 && (
        <GeoJSON
          key={`highlight-${city}-${highlightNeighborhoods.join(",")}`}
          data={highlightCollection}
          style={highlightStyle}
          onEachFeature={(feature: Feature, layer) => {
            const name = feature.properties?.name as string | undefined;
            if (name) layer.bindTooltip(name, { sticky: true });
          }}
        />
      )}
      {showStations && stations.map((station) => (
        <Marker
          key={`${station.name}-${station.latitude}-${station.longitude}`}
          position={[station.latitude, station.longitude]}
          icon={stationIcon(station.lines)}
        >
          <Popup>
            <div className="flex flex-col gap-1 max-w-52">
              <div className="font-medium">{station.name}</div>
              <div className="flex flex-wrap items-center gap-1">
                {station.lines.map((line) => (
                  <TrainLineBadge key={line.name} line={line} />
                ))}
              </div>
            </div>
          </Popup>
        </Marker>
      ))}
      {listings.map((listing) => (
        <Marker key={listing.id} position={[listing.latitude, listing.longitude]} icon={markerIcon}>
          <Popup>
            <div className="flex flex-col gap-1 max-w-52">
              <a href={listing.url} target="_blank" rel="noreferrer" className="font-medium">
                {listing.title}
              </a>
              <div className="text-sm">
                {listing.price != null ? `$${listing.price.toLocaleString()}` : "—"}
                {listing.bedrooms != null ? ` · ${listing.bedrooms}bd` : ""}
                {listing.bathrooms != null ? ` / ${listing.bathrooms}ba` : ""}
              </div>
              {listing.boundaryNeighborhood && (
                <div className="text-xs text-black/60">
                  {listing.locationText && !listing.locationText.toLowerCase().includes(listing.boundaryNeighborhood.toLowerCase())
                    ? `${listing.locationText} → verified: ${listing.boundaryNeighborhood}`
                    : `${listing.boundaryNeighborhood} (verified)`}
                </div>
              )}
              {listing.nearestStation && (
                <div className="flex items-center gap-1.5 text-xs text-black/60">
                  <span>
                    {listing.nearestStation.walkingMinutes} min walk to {listing.nearestStation.name}
                  </span>
                  {listing.nearestStation.lines.map((line) => (
                    <TrainLineBadge key={line.name} line={line} />
                  ))}
                </div>
              )}
              {listing.nextStation && (
                <div className="flex items-center gap-1.5 text-xs text-black/60">
                  <span>
                    also {listing.nextStation.walkingMinutes} min walk to {listing.nextStation.name}
                  </span>
                  {listing.nextStation.lines.map((line) => (
                    <TrainLineBadge key={line.name} line={line} />
                  ))}
                </div>
              )}
            </div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
