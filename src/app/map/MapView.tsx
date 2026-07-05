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

// Wrapped in its own module-scope function (rather than calling Date.now()
// directly in the component body) so React's purity lint rule doesn't flag
// it — same pattern as formatListingAge below, which already does this.
function currentTimestamp(): number {
  return Date.now();
}

// A fixed real-world window (not scaled to whatever's currently on screen) —
// scaling to the current view's own oldest/newest listing made age
// meaningless whenever a search spans multiple cities/searches with very
// different age distributions (e.g. one much older outlier elsewhere made
// every other listing look artificially fresh by comparison, regardless of
// its own real age).
const MARKER_FADE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function opacityForTimestamp(timestamp: number, today: number, minOpacity: number): number {
  const age = Math.max(0, today - timestamp);
  const t = 1 - Math.min(1, age / MARKER_FADE_WINDOW_MS);
  return minOpacity + t * (1 - minOpacity);
}

// A grouped marker's fade reflects its freshest listing — one recent posting
// at a location should still visually pop even if other units there are stale.
function mostRecentTimestamp(group: MapListing[]): number {
  return Math.max(...group.map(listingTimestamp));
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
// Fill fades toward a floor (never fully transparent/unclickable) for older
// listings, so the newest ones visually pop out on a crowded map. Only the
// fill's alpha channel fades — the white outline and shadow stay fully
// opaque so every marker (regardless of age) stays equally easy to see and
// click on a crowded map.
const MARKER_MIN_OPACITY = 0.5;
// Listings sharing the exact same coordinates (e.g. multiple units in the same
// building) are grouped into a single marker — count > 1 renders that count
// directly on the dot (bigger, so the number stays legible) instead of one
// marker per listing stacked invisibly on top of each other.
function listingMarkerIcon(opacity: number, count: number): L.DivIcon {
  if (count <= 1) {
    return L.divIcon({
      className: "",
      html: `<div style="width:14px;height:14px;border-radius:9999px;background:rgba(220,38,38,${opacity});border:2px solid white;box-shadow:0 0 0 1px rgba(0,0,0,0.4)"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
  }
  const size = 20;
  return L.divIcon({
    className: "",
    html: `<div style="width:${size}px;height:${size}px;border-radius:9999px;background:rgba(220,38,38,${opacity});border:2px solid white;box-shadow:0 0 0 1px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:700;line-height:1">${count}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
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

  // A listing posted today is always fully solid; one MARKER_FADE_WINDOW_MS
  // or older fades all the way down to MARKER_MIN_OPACITY, regardless of
  // what else is currently on screen.
  const todayTimestamp = currentTimestamp();

  // Listings that share the exact same coordinates (e.g. several units in
  // the same building) would otherwise render as fully-overlapping markers
  // you can't tell apart or click through individually — grouped into one
  // marker with a combined popup instead.
  const listingGroups = useMemo(() => {
    const byLocation = new Map<string, MapListing[]>();
    for (const listing of listings) {
      const key = `${listing.latitude.toFixed(6)},${listing.longitude.toFixed(6)}`;
      const group = byLocation.get(key);
      if (group) group.push(listing);
      else byLocation.set(key, [listing]);
    }
    return Array.from(byLocation.values());
  }, [listings]);

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
      {listingGroups.map((group) => {
        const [first] = group;
        const opacity = opacityForTimestamp(mostRecentTimestamp(group), todayTimestamp, MARKER_MIN_OPACITY);
        return (
          <Marker
            key={`${first.latitude},${first.longitude}`}
            position={[first.latitude, first.longitude]}
            icon={listingMarkerIcon(opacity, group.length)}
          >
            <Popup>
              {group.length === 1 ? (
                <ListingDetail listing={first} />
              ) : (
                <div className="flex flex-col gap-2 max-w-64 max-h-64 overflow-y-auto">
                  <div className="font-medium text-sm">{group.length} listings at this location</div>
                  {group.map((listing) => (
                    <div key={listing.id} className="flex flex-col gap-0.5 border-t border-black/10 pt-2 first:border-t-0 first:pt-0">
                      <a href={listing.url} target="_blank" rel="noreferrer" className="font-medium text-sm">
                        {listing.title}
                      </a>
                      <div className="text-xs text-black/60">
                        {listing.price != null ? `$${listing.price.toLocaleString()}` : "—"}
                        {listing.bedrooms != null ? ` · ${listing.bedrooms}bd` : ""}
                        {listing.bathrooms != null ? ` / ${listing.bathrooms}ba` : ""}
                        {" · "}
                        {formatListingAge(listing)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Popup>
          </Marker>
        );
      })}
    </MapContainer>
  );
}

function ListingDetail({ listing }: { listing: MapListing }) {
  return (
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
  );
}
