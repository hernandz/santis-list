"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { MapContainer, TileLayer, Marker, Popup, GeoJSON, useMap } from "react-leaflet";
import { useEffect, useMemo } from "react";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { PathOptions } from "leaflet";
import { TrainLineBadge, type TransitLine } from "@/components/TrainLineBadge";

type NearestStationInfo = { name: string; lines: TransitLine[]; distanceMiles: number; walkingMinutes: number };
type CommuteInfo = { minutes: number; distanceMiles: number; approximate: boolean };

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
  commuteCar?: CommuteInfo | null;
  commuteBike?: CommuteInfo | null;
  commuteTransit?: CommuteInfo | null;
  postedAt: string | null;
  firstSeenAt: string;
};

function formatCommuteInfo(commute: CommuteInfo | null | undefined): string | null {
  if (!commute) return null;
  return `${commute.minutes} min (${commute.distanceMiles.toFixed(1)} mi)${commute.approximate ? " ~" : ""}`;
}

function listingTimestamp(listing: MapListing): number {
  return new Date(listing.postedAt ?? listing.firstSeenAt).getTime();
}

function opacityForListing(listing: MapListing, oldest: number, newest: number, minOpacity: number): number {
  if (newest === oldest) return 1;
  const t = (listingTimestamp(listing) - oldest) / (newest - oldest);
  return minOpacity + t * (1 - minOpacity);
}

function formatListingAge(listing: MapListing): string {
  const diffMs = Date.now() - listingTimestamp(listing);
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "1 day ago";
  return `${diffDays} days ago`;
}

export type MapStation = { name: string; lines: TransitLine[]; latitude: number; longitude: number };
export type MapBoundary = { name: string; geometry: Geometry };

const CITY_CENTERS: Record<string, [number, number]> = {
  newyork: [40.7128, -73.935],
  sfbay: [37.8, -122.27],
  losangeles: [34.05, -118.35],
};

// MapContainer's center/zoom props only apply on initial mount — react-leaflet
// doesn't reactively re-center on prop changes, so switching city while the
// map is already mounted needs an imperative setView via the map instance.
function RecenterOnCityChange({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, zoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center[0], center[1], zoom, map]);
  return null;
}

// Deliberately saturated, high-contrast colors — the CARTO Positron basemap
// is intentionally pale/low-contrast (that's what makes it "basic"), so
// markers need real brand-saturated colors to still read clearly against it.
// Opacity fades toward a floor (never fully transparent/unclickable) for
// older listings, so the newest ones visually pop out on a crowded map.
const MARKER_MIN_OPACITY = 0.25;
function listingMarkerIcon(opacity: number): L.DivIcon {
  return L.divIcon({
    className: "",
    html: `<div style="width:14px;height:14px;border-radius:9999px;background:#dc2626;border:2px solid white;box-shadow:0 0 0 1px rgba(0,0,0,0.4);opacity:${opacity}"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

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

// A star, distinct from both the round listing markers and the small round
// station dots — this is a single fixed point of interest, not one of many.
const workIcon = L.divIcon({
  className: "",
  html: '<div style="font-size:22px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.6))">⭐</div>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

export function MapView({
  listings,
  city,
  stations = [],
  boundaries = [],
  highlightNeighborhoods = [],
  showStations = true,
  workLocation = null,
}: {
  listings: MapListing[];
  city: string;
  stations?: MapStation[];
  boundaries?: MapBoundary[];
  highlightNeighborhoods?: string[];
  showStations?: boolean;
  workLocation?: { latitude: number; longitude: number } | null;
}) {
  const center = useMemo(() => CITY_CENTERS[city] ?? CITY_CENTERS.newyork, [city]);

  // Older listings fade toward MARKER_MIN_OPACITY, scaled to the oldest/newest
  // currently on screen (not a fixed absolute age) — a listing that's "old"
  // in a search returning mostly today's posts should still stand out as
  // relatively old, even if it's only a few days old in absolute terms.
  const listingAges = listings.map(listingTimestamp);
  const oldestTimestamp = listingAges.length > 0 ? Math.min(...listingAges) : 0;
  const newestTimestamp = listingAges.length > 0 ? Math.max(...listingAges) : 0;

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
      <RecenterOnCityChange center={center} zoom={12} />
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
      {workLocation && (
        <Marker position={[workLocation.latitude, workLocation.longitude]} icon={workIcon}>
          <Popup>Your work address</Popup>
        </Marker>
      )}
      {listings.map((listing) => (
        <Marker
          key={listing.id}
          position={[listing.latitude, listing.longitude]}
          icon={listingMarkerIcon(opacityForListing(listing, oldestTimestamp, newestTimestamp, MARKER_MIN_OPACITY))}
        >
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
              <div className="text-xs text-black/50">Listed {formatListingAge(listing)}</div>
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
              {formatCommuteInfo(listing.commuteTransit) && (
                <div className="text-xs text-black/60">🚆 {formatCommuteInfo(listing.commuteTransit)} to work</div>
              )}
              {formatCommuteInfo(listing.commuteBike) && (
                <div className="text-xs text-black/60">🚴 {formatCommuteInfo(listing.commuteBike)} to work</div>
              )}
              {formatCommuteInfo(listing.commuteCar) && (
                <div className="text-xs text-black/60">🚗 {formatCommuteInfo(listing.commuteCar)} to work</div>
              )}
            </div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
