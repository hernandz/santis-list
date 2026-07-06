"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { VISIBLE_CITIES } from "@/lib/craigslistCities";
import { defaultCommuteModeForCity, commuteModeEmoji } from "@/lib/commuteMode";
import { TrainLineBadge, type TransitLine } from "@/components/TrainLineBadge";

type NearestStationInfo = { name: string; lines: TransitLine[]; distanceMiles: number; walkingMinutes: number };

type Listing = {
  id: string;
  title: string;
  url: string;
  price: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  locationText: string | null;
  city: string;
  latitude: number | null;
  longitude: number | null;
  postedAt: string | null;
  firstSeenAt: string;
  matches: { watch: { id: string; name: string } }[];
  nearestStation: NearestStationInfo | null;
  nextStation: NearestStationInfo | null;
  boundaryNeighborhood: string | null;
  commute?: { minutes: number; distanceMiles: number; approximate: boolean } | null;
  medianRent: number | null;
  minRent: number | null;
  maxRent: number | null;
};

type ListingsResponse = {
  listings: Listing[];
  page: number;
  totalPages: number;
  total: number;
  truncated?: boolean;
};

const emptyFilters = {
  city: "newyork",
  keyword: "",
  neighborhood: "",
  minPrice: "",
  maxPrice: "",
  minBedrooms: "",
  minBathrooms: "",
  maxWalkMinutes: "",
  // Comma-joined list of selected line names (multi-select) — kept as a plain
  // string so it fits the generic string-only updateFilter() below.
  trainLines: "",
  sort: "newest",
};

type WatchSummary = { id: string; name: string; city: string };

// The "saved search scope" (all watches / a specific watch / none) is a
// separate axis from the ad-hoc filters below — both apply as additional
// AND constraints server-side, so you can combine e.g. "all saved searches"
// with a further ad-hoc max price.
const ALL_WATCHES_SCOPE = "__all__";
const SCOPE_STORAGE_KEY = "feed:scope";
const VISITED_STORAGE_KEY = "feed:visited";

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatLocation(listing: Listing): string {
  const label = listing.locationText ?? listing.city;
  if (!listing.boundaryNeighborhood) return label;

  const matches = label.toLowerCase().includes(listing.boundaryNeighborhood.toLowerCase());
  return matches ? `${label} (verified)` : `${label} → verified: ${listing.boundaryNeighborhood}`;
}

function formatCommute(commute: Listing["commute"]): string {
  if (!commute) return "—";
  const distance = commute.distanceMiles.toFixed(1);
  return `${commute.minutes} min (${distance} mi)${commute.approximate ? " ~" : ""}`;
}

// Mid-range lightness so it reads against both light and dark backgrounds.
function hueColor(hue: number): string {
  return `hsl(${hue}, 80%, 45%)`;
}
const BEST_COLOR = hueColor(120); // green

// Fixed (not relative to what's on screen) — 0 min is always green, 20 min
// (the cap already used server-side for a "next station" to even qualify)
// is always red, so the color means the same thing across every search.
const WALK_MIN_MINUTES = 0;
const WALK_MAX_MINUTES = 20;

// Red (worst/highest) → green (best/lowest) text color, relative to the
// min/max of whatever's currently on screen — not a fixed absolute scale,
// since "a good price" means different things in different searches.
function gradientTextColor(value: number | null | undefined, min: number, max: number): React.CSSProperties {
  if (value == null || min === max) return {};
  const t = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return { color: hueColor((1 - t) * 120) }; // 120° = green, 0° = red
}

function numericRange(values: (number | null | undefined)[]): [number, number] {
  const nums = values.filter((v): v is number => v != null);
  if (nums.length === 0) return [0, 0];
  return [Math.min(...nums), Math.max(...nums)];
}

// Yellow at the median, green at the real minimum for this neighborhood +
// bedroom count, red at the real maximum — unlike gradientTextColor above
// (relative to whatever happens to be on screen), this is relative to a real
// external reference (see medianRent/minRent/maxRent on Listing). The two
// halves scale independently (min-to-median vs median-to-max) since that
// spread is rarely symmetric — a $200-below-median listing and a
// $200-above-median one shouldn't necessarily look equally saturated if one
// side of the range is much wider than the other. No color at all when
// there's no verified neighborhood/bedroom count to compare against, rather
// than falling back to a page-relative gradient, which would silently change
// what the color means listing to listing.
function medianRelativeColor(
  price: number | null,
  medianRent: number | null,
  minRent: number | null,
  maxRent: number | null,
): React.CSSProperties {
  if (price == null || medianRent == null || minRent == null || maxRent == null) return {};
  let t: number;
  if (price <= medianRent) {
    t = medianRent === minRent ? 0 : (price - medianRent) / (medianRent - minRent);
  } else {
    t = maxRent === medianRent ? 0 : (price - medianRent) / (maxRent - medianRent);
  }
  t = Math.min(1, Math.max(-1, t));
  // t=0 (at median) -> 60° yellow; t=-1 (at min) -> 120° green; t=1 (at max) -> 0° red.
  return { color: hueColor(60 - t * 60) };
}

function formatRelativeDays(value: string | null) {
  if (!value) return null;
  const diffMs = Date.now() - new Date(value).getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "1 day ago";
  return `${diffDays} days ago`;
}

function ListingsFeedPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const scopeFromUrl = searchParams.get("scope");

  const [filters, setFilters] = useState(emptyFilters);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListingsResponse | null>(null);
  const [commuteMode, setCommuteMode] = useState<"" | "car" | "bike" | "transit">(
    defaultCommuteModeForCity(emptyFilters.city),
  );
  const [hasWorkAddress, setHasWorkAddress] = useState(false);
  // LA's train-line filter starts collapsed by default — LA Metro rail is
  // sparse enough relative to the city's size that it's a much less
  // universally-relevant filter there than in NYC/SF.
  const [trainLinesExpanded, setTrainLinesExpanded] = useState(emptyFilters.city !== "losangeles");
  // Same reasoning for the results column itself — LA is car-dependent
  // enough that distance-to-train isn't a universally useful thing to show
  // by default, though it's still one click away.
  const [showTrainColumn, setShowTrainColumn] = useState(emptyFilters.city !== "losangeles");
  const [loading, setLoading] = useState(true);
  // Which listings you've already clicked through to on Craigslist, greyed
  // out afterward so a long list of familiar results is easier to scan for
  // what's actually new. Persisted to localStorage (not just component
  // state) so it survives a page reload/revisit, same as the saved-search
  // scope above — starts empty here (SSR has no localStorage) and hydrates
  // from it on mount.
  const [visitedIds, setVisitedIds] = useState<Set<string>>(new Set());

  const [watches, setWatches] = useState<WatchSummary[]>([]);
  // Defaults to "all saved searches" — results automatically reflect every
  // active saved search's current criteria unless you explicitly pick otherwise.
  const [scope, setScope] = useState(scopeFromUrl ?? ALL_WATCHES_SCOPE);

  const [trainLines, setTrainLines] = useState<TransitLine[]>([]);

  const [watchesLoaded, setWatchesLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/watches", { cache: "no-store" })
      .then((res) => res.json())
      .then(setWatches)
      .catch(() => setWatches([]))
      .finally(() => setWatchesLoaded(true));
  }, []);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(VISITED_STORAGE_KEY);
      // Reading localStorage (an external system unavailable during SSR) is
      // exactly the documented exception to "don't setState in an effect".
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (stored) setVisitedIds(new Set(JSON.parse(stored)));
    } catch {
      // corrupt/unexpected localStorage contents — just start empty rather than crash
    }
  }, []);

  function markVisited(id: string) {
    setVisitedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      localStorage.setItem(VISITED_STORAGE_KEY, JSON.stringify(Array.from(next)));
      return next;
    });
  }

  // Train lines are city-specific (NYC letters, BART colors, LA Metro names),
  // so re-fetch whenever the city filter changes.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!filters.city) {
        if (!cancelled) setTrainLines([]);
        return;
      }
      try {
        const res = await fetch(`/api/craigslist/train-lines?city=${encodeURIComponent(filters.city)}`, {
          cache: "no-store",
        });
        const body = await res.json();
        if (!cancelled) setTrainLines(body.lines ?? []);
      } catch {
        if (!cancelled) setTrainLines([]);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [filters.city]);

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((res) => res.json())
      .then((body) => setHasWorkAddress(body.workLatitude != null && body.workLongitude != null))
      .catch(() => setHasWorkAddress(false));
  }, []);

  // Runs on every mount — including navigating here via the nav link after
  // editing a saved search — and whenever this tab regains focus, so the
  // "all searches" / specific-search view always reflects current criteria
  // (it's applied live server-side against the watches' current settings,
  // never a cached snapshot). Falls back to the last remembered scope (since
  // the nav link itself is a plain "/" with no way to carry state) before
  // defaulting to "all saved searches".
  useEffect(() => {
    function sync() {
      const remembered = scopeFromUrl ?? localStorage.getItem(SCOPE_STORAGE_KEY) ?? ALL_WATCHES_SCOPE;
      setScope(remembered);
      const targetPath = remembered === "" ? "/" : `/?scope=${remembered}`;
      // Only replace when the URL would actually change — calling
      // router.replace unconditionally on every mount/focus (even when
      // already correct) re-triggers this Suspense-wrapped page's mount
      // cycle, which re-runs this very effect, which replaces again... an
      // infinite loop that briefly looked like a scope/watches dependency
      // issue but was really just this repeatedly "changing" the URL to the
      // same value it already was.
      if (window.location.pathname + window.location.search !== targetPath) {
        router.replace(targetPath, { scroll: false });
      }
    }
    sync();
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);

      const params = new URLSearchParams();
      if (scope === ALL_WATCHES_SCOPE) {
        params.set("useAllWatches", "true");
      } else if (scope) {
        params.set("watchId", scope);
      }
      if (filters.city) params.set("city", filters.city);
      if (filters.keyword) params.set("keyword", filters.keyword);
      if (filters.neighborhood) params.set("neighborhood", filters.neighborhood);
      if (filters.minPrice) params.set("minPrice", filters.minPrice);
      if (filters.maxPrice) params.set("maxPrice", filters.maxPrice);
      if (filters.minBedrooms) params.set("minBedrooms", filters.minBedrooms);
      if (filters.minBathrooms) params.set("minBathrooms", filters.minBathrooms);
      if (filters.maxWalkMinutes) params.set("maxWalkMinutes", filters.maxWalkMinutes);
      if (filters.trainLines) params.set("trainLines", filters.trainLines);
      params.set("sort", filters.sort);
      params.set("page", String(page));
      if (commuteMode) params.set("commuteMode", commuteMode);

      const res = await fetch(`/api/listings?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!cancelled) {
        setData(json);
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [filters, page, scope, commuteMode]);

  function updateFilter<K extends keyof typeof emptyFilters>(key: K, value: string) {
    setPage(1);
    setFilters((prev) => ({
      ...prev,
      [key]: value,
      // train lines are city-specific, so switching city invalidates any selection
      ...(key === "city" ? { trainLines: "" } : {}),
    }));
  }

  function toggleTrainLine(name: string) {
    setPage(1);
    setFilters((prev) => {
      const selected = prev.trainLines ? prev.trainLines.split(",") : [];
      const next = selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name];
      return { ...prev, trainLines: next.join(",") };
    });
  }

  // Clicking "Price" toggles low<->high; clicking "Listed"/"Train" just
  // switches to that column's one sort direction (there's no "oldest first"
  // or "farthest first" mode currently).
  function handleHeaderSort(column: "listed" | "train" | "price" | "commute") {
    if (column === "listed") return updateFilter("sort", "newest");
    if (column === "train") return updateFilter("sort", "distance_to_train");
    if (column === "commute") return updateFilter("sort", "commute");
    return updateFilter("sort", filters.sort === "price_asc" ? "price_desc" : "price_asc");
  }

  function sortIndicator(active: boolean, direction?: "asc" | "desc") {
    if (!active) return null;
    return <span aria-hidden> {direction === "asc" ? "↑" : direction === "desc" ? "↓" : "•"}</span>;
  }

  // Grouped by transit system/operator — only meaningful for cities that mix
  // multiple independent operators (sfbay: BART/Muni Metro/Caltrain/VTA),
  // where every line has a `system`. Single-operator cities (NYC subway, LA
  // Metro) have no `system` on any line, so this collapses to one ungrouped
  // ("") bucket and the UI below skips rendering a header for it.
  const trainLineGroups = useMemo(() => {
    const groups = new Map<string, TransitLine[]>();
    for (const line of trainLines) {
      const key = line.system ?? "";
      const group = groups.get(key);
      if (group) group.push(line);
      else groups.set(key, [line]);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [trainLines]);

  // Fixed pixel column widths only apply from sm: up — below that, rows
  // stack into a single-column card layout instead (see the header/row
  // className usage below), since fixed-width columns can't shrink to fit a
  // phone screen without overlapping/illegible content. Column order is
  // Listing, Price, Train (if shown), Commute (if shown), Listed — matching
  // the order the row/header elements are written in below, since that same
  // order is what determines stacking order on mobile. Written as complete
  // literal class strings (not built by concatenating fragments) so
  // Tailwind's JIT scanner can actually find them.
  const gridColsClass = showTrainColumn
    ? commuteMode
      ? "sm:grid-cols-[1fr_100px_170px_100px_120px]"
      : "sm:grid-cols-[1fr_100px_170px_120px]"
    : commuteMode
      ? "sm:grid-cols-[1fr_100px_100px_120px]"
      : "sm:grid-cols-[1fr_100px_120px]";

  // Commute's gradient range is computed over whatever's currently on screen
  // (this page of results), not the whole search — the full result set could
  // span thousands of rows across many un-fetched pages, and colors would
  // have to shift as you compute more of it anyway. Price doesn't need this
  // — it's colored against a real external reference (medianRent) instead.
  const [commuteMin, commuteMax] = numericRange(data?.listings.map((l) => l.commute?.minutes) ?? []);

  // Keeps the ad-hoc City filter (and the city-derived defaults) in sync
  // with whatever the effective scope actually is. This can't just live
  // inside handleSelectScope: scope is also restored from localStorage/the
  // URL on mount (see the sync() effect above), and at that moment `watches`
  // may not have finished loading yet — a plain inline update at click time
  // would miss that case entirely, which is exactly how a restored
  // LA-specific search could sit next to a leftover "New York City" ad-hoc
  // filter and silently return zero results. Re-running off [scope, watches]
  // covers both the manual-switch case and the mount/restore race — a
  // legitimate "adjust state when derived-from-props value changes" effect
  // (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  const lastSyncedScopeRef = useRef<string | null>(null);
  useEffect(() => {
    if (scope === "") return; // browse-everything: leave ad-hoc filters exactly as the user set them
    if (scope === ALL_WATCHES_SCOPE) {
      // Only apply once per distinct scope value — this effect's own
      // setFilters call changes `filters`, which isn't a dependency here, so
      // that alone can't cause a loop, but re-applying unconditionally on
      // every [scope, watches] change (e.g. once watches finishes loading)
      // is still unnecessary work. Guarding on a ref sidesteps it entirely.
      if (lastSyncedScopeRef.current === scope) return;
      lastSyncedScopeRef.current = scope;
      // "All saved searches" can span multiple watches across different
      // cities — a leftover ad-hoc City filter would silently AND against
      // every watch's own city condition and can zero out the results
      // entirely if it doesn't match any active watch's city.
      setFilters((prev) => (prev.city === "" && prev.trainLines === "" ? prev : { ...prev, city: "", trainLines: "" }));
      return;
    }
    const watch = watches.find((w) => w.id === scope);
    if (!watch) return; // watches hasn't loaded yet, or scope refers to a deleted/unknown watch
    if (lastSyncedScopeRef.current === scope) return;
    lastSyncedScopeRef.current = scope;
    setFilters((prev) =>
      prev.city === watch.city && prev.trainLines === "" ? prev : { ...prev, city: watch.city, trainLines: "" },
    );
    setCommuteMode(defaultCommuteModeForCity(watch.city));
    setTrainLinesExpanded(watch.city !== "losangeles");
    setShowTrainColumn(watch.city !== "losangeles");
  }, [scope, watches]);

  function handleSelectScope(next: string) {
    setPage(1);
    setScope(next);
    localStorage.setItem(SCOPE_STORAGE_KEY, next);
    router.replace(next === "" ? "/" : `/?scope=${next}`, { scroll: false });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Listings Feed</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Everything the crawler has found for your active saved searches.
        </p>
      </div>

      {watchesLoaded && watches.length === 0 && (
        <div className="border border-black/10 dark:border-white/15 rounded-lg p-4 flex flex-col gap-1">
          <p className="text-sm font-medium">👋 New here? Get set up in two steps:</p>
          <p className="text-sm text-black/70 dark:text-white/70">
            1. Head to{" "}
            <Link href="/settings" className="underline">
              Settings
            </Link>{" "}
            and add your alert email and work address (for commute times).
          </p>
          <p className="text-sm text-black/70 dark:text-white/70">
            2. Then{" "}
            <Link href="/watches/new" className="underline">
              create a saved search
            </Link>{" "}
            — city, neighborhoods, price range — and the crawler takes it from there.
          </p>
        </div>
      )}

      <label className="flex flex-col gap-1 text-xs max-w-xs">
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
        <span className="text-black/50 dark:text-white/50">
          {scope === ALL_WATCHES_SCOPE
            ? "Showing anything matching at least one of your active saved searches, using their current criteria."
            : scope
              ? "Showing only what matches this saved search's current criteria."
              : "No saved-search restriction — use the filters below to browse everything crawled."}
        </span>
      </label>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 border border-black/10 dark:border-white/15 rounded-lg p-4">
        <label className="flex flex-col gap-1 text-xs">
          City
          <select
            className="border rounded px-2 py-1 text-sm border-black/15 dark:border-white/20 bg-transparent"
            value={filters.city}
            onChange={(e) => {
              updateFilter("city", e.target.value);
              if (e.target.value) setCommuteMode(defaultCommuteModeForCity(e.target.value));
              setTrainLinesExpanded(e.target.value !== "losangeles");
              setShowTrainColumn(e.target.value !== "losangeles");
            }}
          >
            <option value="">All cities</option>
            {VISIBLE_CITIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Keyword
          <input
            className="border rounded px-2 py-1 text-sm border-black/15 dark:border-white/20 bg-transparent"
            placeholder="e.g. parking, pool"
            value={filters.keyword}
            onChange={(e) => updateFilter("keyword", e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Neighborhood
          <input
            className="border rounded px-2 py-1 text-sm border-black/15 dark:border-white/20 bg-transparent"
            placeholder="e.g. ridgewood"
            value={filters.neighborhood}
            onChange={(e) => updateFilter("neighborhood", e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Min price
          <input
            type="number"
            className="border rounded px-2 py-1 text-sm border-black/15 dark:border-white/20 bg-transparent"
            value={filters.minPrice}
            onChange={(e) => updateFilter("minPrice", e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Max price
          <input
            type="number"
            className="border rounded px-2 py-1 text-sm border-black/15 dark:border-white/20 bg-transparent"
            value={filters.maxPrice}
            onChange={(e) => updateFilter("maxPrice", e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Min beds
          <input
            type="number"
            className="border rounded px-2 py-1 text-sm border-black/15 dark:border-white/20 bg-transparent"
            value={filters.minBedrooms}
            onChange={(e) => updateFilter("minBedrooms", e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Min baths
          <input
            type="number"
            className="border rounded px-2 py-1 text-sm border-black/15 dark:border-white/20 bg-transparent"
            value={filters.minBathrooms}
            onChange={(e) => updateFilter("minBathrooms", e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Max walk to train (min)
          <input
            type="number"
            min={0}
            className="border rounded px-2 py-1 text-sm border-black/15 dark:border-white/20 bg-transparent"
            placeholder="e.g. 10"
            value={filters.maxWalkMinutes}
            onChange={(e) => updateFilter("maxWalkMinutes", e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs col-span-2 sm:col-span-1">
          Sort
          <select
            className="border rounded px-2 py-1 text-sm border-black/15 dark:border-white/20 bg-transparent"
            value={filters.sort}
            onChange={(e) => updateFilter("sort", e.target.value)}
          >
            <option value="newest">Newest</option>
            <option value="price_asc">Price: low to high</option>
            <option value="price_desc">Price: high to low</option>
            <option value="distance_to_train">Distance to train: closest first</option>
            {commuteMode && <option value="commute">Commute to work: shortest first</option>}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs col-span-2">
          <span className="whitespace-nowrap">Commute to work (estimate)</span>
          <select
            className="border rounded px-2 py-1 text-sm border-black/15 dark:border-white/20 bg-transparent"
            value={commuteMode}
            onChange={(e) => {
              const next = e.target.value as typeof commuteMode;
              setCommuteMode(next);
              if (!next && filters.sort === "commute") updateFilter("sort", "newest");
            }}
          >
            <option value="">Off</option>
            <option value="car">By car</option>
            <option value="bike">By bike</option>
            <option value="transit">By transit</option>
          </select>
          {commuteMode && !hasWorkAddress && (
            <span className="text-black/40 dark:text-white/40">Set a work address in Settings first</span>
          )}
        </label>
      </div>

      {filters.city && (
        <div className="flex flex-col gap-1.5 border border-black/10 dark:border-white/15 rounded-lg p-4">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setTrainLinesExpanded((prev) => !prev)}
              className="text-xs text-left flex items-center gap-1"
            >
              <span aria-hidden>{trainLinesExpanded ? "▾" : "▸"}</span>
              Train lines (select any number — matches listings near any of them)
              {!trainLinesExpanded && filters.trainLines && (
                <span className="text-black/50 dark:text-white/50">
                  ({filters.trainLines.split(",").filter(Boolean).length} selected)
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setShowTrainColumn((prev) => !prev)}
              className="text-xs shrink-0 border rounded px-2 py-1 border-black/15 dark:border-white/20"
            >
              {showTrainColumn ? "Hide" : "Show"} train column
            </button>
          </div>
          {trainLinesExpanded && (
            <div className="flex flex-col gap-2">
              {trainLines.length === 0 && (
                <span className="text-xs text-black/40 dark:text-white/40">Loading lines for this city…</span>
              )}
              {trainLineGroups.map(([system, lines]) => (
                <div key={system} className="flex flex-col gap-1">
                  {system && (
                    <span className="text-[11px] font-medium uppercase tracking-wide text-black/40 dark:text-white/40">
                      {system}
                    </span>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {lines.map((line) => {
                      const selected = filters.trainLines.split(",").includes(line.name);
                      return (
                        <button
                          key={line.name}
                          type="button"
                          onClick={() => toggleTrainLine(line.name)}
                          className="flex items-center gap-1"
                          title={line.name}
                        >
                          <span
                            className={`inline-flex w-5 h-5 rounded-full ${selected ? "ring-2 ring-offset-1 ring-black dark:ring-white ring-offset-transparent" : "opacity-40"}`}
                          >
                            <TrainLineBadge line={line} />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {data?.truncated && (
        <p className="text-xs text-amber-600 dark:text-amber-400 -mt-3">
          Neighborhood, train line, walk time, and commute filtering/sorting only consider the most recent matching
          listings up to an internal cap — there are more results than that in total, so a few older ones may be
          left out.
        </p>
      )}

      {loading && !data && <p className="text-sm text-black/50 dark:text-white/50">Loading…</p>}

      {!loading && data && data.listings.length === 0 && (
        <p className="text-sm text-black/50 dark:text-white/50">
          No listings match this view yet. Create/adjust a saved search under &quot;Saved Searches&quot; and wait
          for the next crawl cycle, or switch scope above.
        </p>
      )}

      <div className="border border-black/10 dark:border-white/15 rounded-lg overflow-hidden">
        <div className={`hidden sm:grid ${gridColsClass} gap-4 px-4 py-2 text-xs font-medium text-black/50 dark:text-white/50 border-b border-black/10 dark:border-white/15`}>
          <div className="flex items-center gap-2">
            Listing
            {loading && (
              <span
                className="inline-block w-3 h-3 border-2 border-black/40 dark:border-white/40 border-t-transparent rounded-full animate-spin"
                role="status"
                aria-label="Loading listings"
              />
            )}
          </div>
          <button
            type="button"
            onClick={() => handleHeaderSort("price")}
            className="text-left hover:text-black dark:hover:text-white"
          >
            Price
            {sortIndicator(
              filters.sort === "price_asc" || filters.sort === "price_desc",
              filters.sort === "price_asc" ? "asc" : filters.sort === "price_desc" ? "desc" : undefined,
            )}
          </button>
          {showTrainColumn && (
            <button
              type="button"
              onClick={() => handleHeaderSort("train")}
              className="text-left hover:text-black dark:hover:text-white"
            >
              Train{sortIndicator(filters.sort === "distance_to_train")}
            </button>
          )}
          {commuteMode && (
            <button
              type="button"
              onClick={() => handleHeaderSort("commute")}
              className="text-left hover:text-black dark:hover:text-white"
            >
              Commute {commuteModeEmoji(commuteMode)}
              {sortIndicator(filters.sort === "commute")}
            </button>
          )}
          <button
            type="button"
            onClick={() => handleHeaderSort("listed")}
            className="text-right hover:text-black dark:hover:text-white"
          >
            Listed{sortIndicator(filters.sort === "newest")}
          </button>
        </div>
        <div className="flex flex-col divide-y divide-black/10 dark:divide-white/15">
          {data?.listings.map((listing) => (
            <a
              key={listing.id}
              href={listing.url}
              target="_blank"
              rel="noreferrer"
              onClick={() => markVisited(listing.id)}
              className={`flex flex-col gap-2 sm:grid ${gridColsClass} sm:items-center sm:gap-4 px-4 py-3 hover:bg-black/[.03] dark:hover:bg-white/[.05]${visitedIds.has(listing.id) ? " opacity-45" : ""}`}
            >
              <div className="min-w-0">
                <div className="font-medium sm:truncate">{listing.title}</div>
                <div className="text-xs text-black/60 dark:text-white/60">
                  {formatLocation(listing)}
                  {listing.bedrooms != null ? ` · ${listing.bedrooms}bd` : ""}
                  {listing.bathrooms != null ? ` / ${listing.bathrooms}ba` : ""}
                  {" · seen "}
                  {formatDate(listing.firstSeenAt)}
                  {listing.matches.length > 0
                    ? ` · matched: ${listing.matches.map((m) => m.watch.name).join(", ")}`
                    : ""}
                  {(listing.latitude == null || listing.longitude == null) && (
                    <span
                      className="ml-1 text-amber-600 dark:text-amber-400"
                      title="No location data for this listing — it won't appear on the map"
                    >
                      · not on map
                    </span>
                  )}
                </div>
              </div>
              <div
                className="text-left shrink-0 font-semibold"
                title={
                  listing.medianRent != null
                    ? `${listing.bedrooms ?? "?"}bd in ${listing.boundaryNeighborhood}: $${Math.round(listing.minRent!).toLocaleString()} – $${Math.round(listing.maxRent!).toLocaleString()}, median $${Math.round(listing.medianRent).toLocaleString()}`
                    : undefined
                }
                style={medianRelativeColor(listing.price, listing.medianRent, listing.minRent, listing.maxRent)}
              >
                {listing.price != null ? `$${listing.price.toLocaleString()}` : "—"}
              </div>
              {showTrainColumn && (
                <div className="flex flex-col gap-1 text-xs text-black/60 dark:text-white/60">
                  {listing.nearestStation ? (
                    <>
                      <div className="flex items-center gap-1.5">
                        <span style={gradientTextColor(listing.nearestStation.walkingMinutes, WALK_MIN_MINUTES, WALK_MAX_MINUTES)}>
                          {listing.nearestStation.walkingMinutes} min to {listing.nearestStation.name}
                        </span>
                        {listing.nearestStation.lines.map((line) => (
                          <TrainLineBadge key={line.name} line={line} />
                        ))}
                      </div>
                      {listing.nextStation && (
                        <div className="flex items-center gap-1.5 text-black/50 dark:text-white/50">
                          <span>also {listing.nextStation.walkingMinutes} min to {listing.nextStation.name}</span>
                          {listing.nextStation.lines.map((line) => (
                            <TrainLineBadge key={line.name} line={line} />
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="text-black/30 dark:text-white/30">—</span>
                  )}
                </div>
              )}
              {commuteMode && (
                <div
                  className="text-left shrink-0 text-xs text-black/60 dark:text-white/60"
                  style={gradientTextColor(listing.commute?.minutes, commuteMin, commuteMax)}
                >
                  <span className="sm:hidden">{commuteModeEmoji(commuteMode)} </span>
                  {formatCommute(listing.commute)}
                </div>
              )}
              <div className="text-left sm:text-right shrink-0">
                <div
                  className="text-sm text-black/70 dark:text-white/70"
                  style={formatRelativeDays(listing.postedAt) === "today" ? { color: BEST_COLOR } : undefined}
                >
                  {formatRelativeDays(listing.postedAt) ?? "—"}
                </div>
                <div className="text-xs text-black/50 dark:text-white/50">{formatDate(listing.postedAt)}</div>
              </div>
            </a>
          ))}
        </div>
      </div>

      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <button
            className="px-3 py-1 border rounded disabled:opacity-40 border-black/15 dark:border-white/20"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </button>
          <span>
            Page {data.page} of {data.totalPages} ({data.total} total)
          </span>
          <button
            className="px-3 py-1 border rounded disabled:opacity-40 border-black/15 dark:border-white/20"
            disabled={page >= data.totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

export default function ListingsFeedPageWithSuspense() {
  return (
    <Suspense fallback={<p className="text-sm text-black/50 dark:text-white/50">Loading…</p>}>
      <ListingsFeedPage />
    </Suspense>
  );
}
