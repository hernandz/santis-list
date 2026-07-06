"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { VISIBLE_CITIES } from "@/lib/craigslistCities";
import type { MapBoundary, MapListing, MapStation } from "./MapView";

const MapView = dynamic(() => import("./MapView").then((m) => m.MapView), {
  ssr: false,
  loading: () => (
    <div className="h-[70vh] w-full rounded-lg border border-black/10 dark:border-white/15 flex items-center justify-center text-sm text-black/50 dark:text-white/50">
      Loading map…
    </div>
  ),
});

type WatchSummary = { id: string; name: string; city: string; neighborhoods: string[] };

// Same convention as the listings feed: default to showing only what your
// saved searches actually match, rather than an unrestricted city browse.
const ALL_WATCHES_SCOPE = "__all__";

export default function MapPage() {
  const [city, setCity] = useState<string>(VISIBLE_CITIES[0].value);
  const [neighborhood, setNeighborhood] = useState("");
  const [scope, setScope] = useState(ALL_WATCHES_SCOPE);
  const [watches, setWatches] = useState<WatchSummary[]>([]);
  const [listings, setListings] = useState<MapListing[]>([]);
  const [stations, setStations] = useState<MapStation[]>([]);
  const [boundaries, setBoundaries] = useState<MapBoundary[]>([]);
  // Hidden by default for LA — its Metro rail network is sparse enough
  // relative to the city's sprawl that the dots are more clutter than signal
  // there, unlike NYC/SF where they're a much more universally useful layer.
  const [showStations, setShowStations] = useState(VISIBLE_CITIES[0].value !== "losangeles");
  const [loading, setLoading] = useState(true);
  const [workLocation, setWorkLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [notPlotted, setNotPlotted] = useState(0);
  const [notPlottedTruncated, setNotPlottedTruncated] = useState(false);
  const [totalRegardlessOfLocation, setTotalRegardlessOfLocation] = useState(0);

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((res) => res.json())
      .then((body) => {
        setWorkLocation(
          body.workLatitude != null && body.workLongitude != null
            ? { latitude: body.workLatitude, longitude: body.workLongitude }
            : null,
        );
      })
      .catch(() => setWorkLocation(null));
  }, []);

  useEffect(() => {
    fetch("/api/watches", { cache: "no-store" })
      .then((res) => res.json())
      .then(setWatches)
      .catch(() => setWatches([]));
  }, []);

  // Default to whichever city actually has the most crawled listings, rather
  // than always opening on a hardcoded one that might have nothing crawled
  // for it yet. Runs once on mount, before there's been any chance for the
  // user to have already picked a different city themselves.
  useEffect(() => {
    fetch("/api/listings/city-counts", { cache: "no-store" })
      .then((res) => res.json())
      .then((body: { counts?: Record<string, number> }) => {
        const counts = body.counts ?? {};
        const busiest = VISIBLE_CITIES.reduce(
          (best, c) => ((counts[c.value] ?? 0) > (counts[best.value] ?? 0) ? c : best),
          VISIBLE_CITIES[0],
        );
        if ((counts[busiest.value] ?? 0) > 0) {
          setCity(busiest.value);
          setShowStations(busiest.value !== "losangeles");
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/craigslist/stations?city=${encodeURIComponent(city)}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((body) => {
        if (!cancelled) setStations(body.stations ?? []);
      })
      .catch(() => {
        if (!cancelled) setStations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [city]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/craigslist/neighborhood-boundaries?city=${encodeURIComponent(city)}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((body) => {
        if (!cancelled) setBoundaries(body.boundaries ?? []);
      })
      .catch(() => {
        if (!cancelled) setBoundaries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [city]);

  // A specific saved search highlights the neighborhoods it's limited to;
  // "all saved searches" highlights the union across every active watch for
  // the currently-shown city, so you can see everywhere you're searching,
  // not just the listings that happened to match so far.
  const highlightNeighborhoods = useMemo(() => {
    if (scope === "") return [];
    if (scope === ALL_WATCHES_SCOPE) {
      const names = new Set<string>();
      watches.filter((w) => w.city === city).forEach((w) => w.neighborhoods.forEach((n) => names.add(n)));
      return Array.from(names);
    }
    return watches.find((w) => w.id === scope)?.neighborhoods ?? [];
  }, [scope, watches, city]);

  // Picking a specific saved search centers the map on that search's city.
  function handleSelectScope(next: string) {
    setScope(next);
    if (next !== ALL_WATCHES_SCOPE && next !== "") {
      const watch = watches.find((w) => w.id === next);
      if (watch) {
        setCity(watch.city);
        setShowStations(watch.city !== "losangeles");
      }
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const params = new URLSearchParams();
      params.set("forMap", "true");
      params.set("city", city);
      params.set("commuteMode", "both");
      if (neighborhood) params.set("neighborhood", neighborhood);
      if (scope === ALL_WATCHES_SCOPE) {
        params.set("useAllWatches", "true");
      } else if (scope) {
        params.set("watchId", scope);
      }

      const res = await fetch(`/api/listings?${params.toString()}`, { cache: "no-store" });
      const body = await res.json();
      if (!cancelled) {
        setListings(body.listings ?? []);
        setNotPlotted(body.notPlotted ?? 0);
        setTotalRegardlessOfLocation(body.totalRegardlessOfLocation ?? 0);
        setNotPlottedTruncated(body.notPlottedTruncated ?? false);
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [city, neighborhood, scope]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">Map</h1>
          {loading && (
            <span
              className="inline-block w-4 h-4 border-2 border-black/40 dark:border-white/40 border-t-transparent rounded-full animate-spin"
              role="status"
              aria-label="Loading listings"
            />
          )}
        </div>
        <p className="text-sm text-black/60 dark:text-white/60">
          Listings plotted by their Craigslist-provided location, with distance to the nearest transit
          station.
        </p>
        {!loading && notPlotted > 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
            {notPlotted} out of {totalRegardlessOfLocation} crawled listings are not plotted because no
            location was provided.
            {notPlottedTruncated && " (this count is itself capped and may be an undercount.)"}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-3 border border-black/10 dark:border-white/15 rounded-lg p-4">
        <label className="flex flex-col gap-1 text-xs">
          Saved search scope
          <select
            className="border rounded px-2 py-1 text-sm border-black/15 dark:border-white/20 bg-transparent"
            value={scope}
            onChange={(e) => handleSelectScope(e.target.value)}
          >
            <option value={ALL_WATCHES_SCOPE}>All saved searches (default)</option>
            {watches.map((w) => (
              <option key={w.id} value={w.id}>
                Only &quot;{w.name}&quot;
              </option>
            ))}
            <option value="">No saved-search filter (browse everything)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          City
          <select
            className="border rounded px-2 py-1 text-sm border-black/15 dark:border-white/20 bg-transparent"
            value={city}
            onChange={(e) => {
              setCity(e.target.value);
              setShowStations(e.target.value !== "losangeles");
            }}
          >
            {VISIBLE_CITIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Neighborhood
          <input
            className="border rounded px-2 py-1 text-sm border-black/15 dark:border-white/20 bg-transparent"
            placeholder="e.g. ridgewood"
            value={neighborhood}
            onChange={(e) => setNeighborhood(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs justify-end">
          <span className="invisible">Toggle</span>
          <button
            type="button"
            onClick={() => setShowStations((prev) => !prev)}
            className="border rounded px-2 py-1 text-sm border-black/15 dark:border-white/20"
          >
            {showStations ? "Hide" : "Show"} train lines
          </button>
        </label>
      </div>

      {!loading && listings.length === 0 && (
        <p className="text-sm text-black/50 dark:text-white/50">
          No mapped listings for this scope/city/filter yet — only listings where Craigslist provided a
          map location can be plotted.
        </p>
      )}

      <MapView
        listings={listings}
        city={city}
        stations={stations}
        boundaries={boundaries}
        highlightNeighborhoods={highlightNeighborhoods}
        showStations={showStations}
        workLocation={workLocation}
      />
    </div>
  );
}
