"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { VISIBLE_CITIES } from "@/lib/craigslistCities";
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
  postedAt: string | null;
  firstSeenAt: string;
  matches: { watch: { id: string; name: string } }[];
  nearestStation: NearestStationInfo | null;
  nextStation: NearestStationInfo | null;
  boundaryNeighborhood: string | null;
  commute?: { minutes: number; distanceMiles: number; approximate: boolean } | null;
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

// Sensible default per city's actual transit character — LA is far more
// car-dependent than NYC/SF, which both have real heavy-rail systems.
function defaultCommuteModeForCity(city: string): "car" | "transit" {
  return city === "losangeles" ? "car" : "transit";
}

type WatchSummary = { id: string; name: string; city: string };

// The "saved search scope" (all watches / a specific watch / none) is a
// separate axis from the ad-hoc filters below — both apply as additional
// AND constraints server-side, so you can combine e.g. "all saved searches"
// with a further ad-hoc max price.
const ALL_WATCHES_SCOPE = "__all__";
const SCOPE_STORAGE_KEY = "feed:scope";

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

// Red (worst/highest) → green (best/lowest) color scale, relative to the
// min/max of whatever's currently on screen — not a fixed absolute scale,
// since "a good price" means different things in different searches.
function gradientBackground(value: number | null | undefined, min: number, max: number): React.CSSProperties {
  if (value == null || min === max) return {};
  const t = Math.min(1, Math.max(0, (value - min) / (max - min)));
  const hue = (1 - t) * 120; // 120° = green, 0° = red
  return { backgroundColor: `hsla(${hue}, 70%, 50%, 0.16)` };
}

function numericRange(values: (number | null | undefined)[]): [number, number] {
  const nums = values.filter((v): v is number => v != null);
  if (nums.length === 0) return [0, 0];
  return [Math.min(...nums), Math.max(...nums)];
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
  const [commuteMode, setCommuteMode] = useState<"" | "car" | "transit">(defaultCommuteModeForCity(emptyFilters.city));
  const [hasWorkAddress, setHasWorkAddress] = useState(false);
  const [loading, setLoading] = useState(true);

  const [watches, setWatches] = useState<WatchSummary[]>([]);
  // Defaults to "all saved searches" — results automatically reflect every
  // active saved search's current criteria unless you explicitly pick otherwise.
  const [scope, setScope] = useState(scopeFromUrl ?? ALL_WATCHES_SCOPE);

  const [trainLines, setTrainLines] = useState<TransitLine[]>([]);

  useEffect(() => {
    fetch("/api/watches", { cache: "no-store" })
      .then((res) => res.json())
      .then(setWatches)
      .catch(() => setWatches([]));
  }, []);

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
      router.replace(remembered === "" ? "/" : `/?scope=${remembered}`, { scroll: false });
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

  const gridColsClass = commuteMode
    ? "grid-cols-[1fr_170px_130px_120px_100px]"
    : "grid-cols-[1fr_170px_120px_100px]";

  // Gradient ranges are computed over whatever's currently on screen (this
  // page of results), not the whole search — the full result set could span
  // thousands of rows across many un-fetched pages, and colors would have to
  // shift as you compute more of it anyway.
  const [priceMin, priceMax] = numericRange(data?.listings.map((l) => l.price) ?? []);
  const [walkMin, walkMax] = numericRange(data?.listings.map((l) => l.nearestStation?.walkingMinutes) ?? []);
  const [commuteMin, commuteMax] = numericRange(data?.listings.map((l) => l.commute?.minutes) ?? []);

  function handleSelectScope(next: string) {
    setPage(1);
    setScope(next);
    localStorage.setItem(SCOPE_STORAGE_KEY, next);
    router.replace(next === "" ? "/" : `/?scope=${next}`, { scroll: false });

    // A specific watch already restricts to its own city server-side — if the
    // ad-hoc City filter here still says something else, the two conditions
    // contradict each other (city=A AND city=B) and silently return zero
    // results. Auto-set it to match so switching searches doesn't look broken.
    if (next !== ALL_WATCHES_SCOPE && next) {
      const watch = watches.find((w) => w.id === next);
      if (watch) {
        setFilters((prev) => ({ ...prev, city: watch.city, trainLines: "" }));
        setCommuteMode(defaultCommuteModeForCity(watch.city));
      }
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Listings Feed</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Everything the crawler has found for your active saved searches.
        </p>
      </div>

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
          Neighborhood
          <input
            className="border rounded px-2 py-1 text-sm border-black/15 dark:border-white/20 bg-transparent"
            placeholder="ridgewood"
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
        <label className="flex flex-col gap-1 text-xs col-span-2 sm:col-span-1">
          Commute to work
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
            <option value="transit">By transit (estimate)</option>
          </select>
          {commuteMode && !hasWorkAddress && (
            <span className="text-black/40 dark:text-white/40">Set a work address in Settings first</span>
          )}
        </label>
      </div>

      {filters.city && (
        <div className="flex flex-col gap-1.5 border border-black/10 dark:border-white/15 rounded-lg p-4">
          <span className="text-xs">Train lines (select any number — matches listings near any of them)</span>
          <div className="flex flex-wrap gap-2">
            {trainLines.length === 0 && (
              <span className="text-xs text-black/40 dark:text-white/40">Loading lines for this city…</span>
            )}
            {trainLines.map((line) => {
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
      )}

      {data?.truncated && (
        <p className="text-xs text-amber-600 dark:text-amber-400 -mt-3">
          Sorting/filtering by walk time only considers the most recent matching listings up to an internal cap —
          there are more results than that in total, so a few older ones may be left out.
        </p>
      )}

      {loading && <p className="text-sm text-black/50 dark:text-white/50">Loading…</p>}

      {!loading && data && data.listings.length === 0 && (
        <p className="text-sm text-black/50 dark:text-white/50">
          No listings match this view yet. Create/adjust a saved search under &quot;Saved Searches&quot; and wait
          for the next crawl cycle, or switch scope above.
        </p>
      )}

      <div className="border border-black/10 dark:border-white/15 rounded-lg overflow-hidden">
        <div className={`grid ${gridColsClass} gap-4 px-4 py-2 text-xs font-medium text-black/50 dark:text-white/50 border-b border-black/10 dark:border-white/15`}>
          <div>Listing</div>
          <button
            type="button"
            onClick={() => handleHeaderSort("train")}
            className="text-left hover:text-black dark:hover:text-white"
          >
            Train{sortIndicator(filters.sort === "distance_to_train")}
          </button>
          <button
            type="button"
            onClick={() => handleHeaderSort("listed")}
            className="text-right hover:text-black dark:hover:text-white"
          >
            Listed{sortIndicator(filters.sort === "newest")}
          </button>
          <button
            type="button"
            onClick={() => handleHeaderSort("price")}
            className="text-right hover:text-black dark:hover:text-white"
          >
            Price
            {sortIndicator(
              filters.sort === "price_asc" || filters.sort === "price_desc",
              filters.sort === "price_asc" ? "asc" : filters.sort === "price_desc" ? "desc" : undefined,
            )}
          </button>
          {commuteMode && (
            <button
              type="button"
              onClick={() => handleHeaderSort("commute")}
              className="text-right hover:text-black dark:hover:text-white"
            >
              Commute {commuteMode === "car" ? "🚗" : "🚆"}
              {sortIndicator(filters.sort === "commute")}
            </button>
          )}
        </div>
        <div className="flex flex-col divide-y divide-black/10 dark:divide-white/15">
          {data?.listings.map((listing) => (
            <a
              key={listing.id}
              href={listing.url}
              target="_blank"
              rel="noreferrer"
              className={`grid ${gridColsClass} items-center gap-4 px-4 py-3 hover:bg-black/[.03] dark:hover:bg-white/[.05]`}
            >
              <div className="min-w-0">
                <div className="font-medium truncate">{listing.title}</div>
                <div className="text-xs text-black/60 dark:text-white/60">
                  {formatLocation(listing)}
                  {listing.bedrooms != null ? ` · ${listing.bedrooms}bd` : ""}
                  {listing.bathrooms != null ? ` / ${listing.bathrooms}ba` : ""}
                  {" · seen "}
                  {formatDate(listing.firstSeenAt)}
                  {listing.matches.length > 0
                    ? ` · matched: ${listing.matches.map((m) => m.watch.name).join(", ")}`
                    : ""}
                </div>
              </div>
              <div
                className="flex flex-col gap-1 text-xs text-black/60 dark:text-white/60 rounded px-1.5 py-1 -mx-1.5"
                style={gradientBackground(listing.nearestStation?.walkingMinutes, walkMin, walkMax)}
              >
                {listing.nearestStation ? (
                  <>
                    <div className="flex items-center gap-1.5">
                      <span>{listing.nearestStation.walkingMinutes} min to {listing.nearestStation.name}</span>
                      {listing.nearestStation.lines.map((line) => (
                        <TrainLineBadge key={line.name} line={line} />
                      ))}
                    </div>
                    {listing.nextStation && (
                      <div className="flex items-center gap-1.5 text-black/50 dark:text-white/50">
                        <span>+{listing.nextStation.walkingMinutes} min to {listing.nextStation.name}</span>
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
              <div className="text-right shrink-0">
                <div className="text-sm text-black/70 dark:text-white/70">
                  {formatRelativeDays(listing.postedAt) ?? "—"}
                </div>
                <div className="text-xs text-black/50 dark:text-white/50">{formatDate(listing.postedAt)}</div>
              </div>
              <div
                className="text-right shrink-0 font-semibold rounded px-1.5 py-1 -mx-1.5"
                style={gradientBackground(listing.price, priceMin, priceMax)}
              >
                {listing.price != null ? `$${listing.price.toLocaleString()}` : "—"}
              </div>
              {commuteMode && (
                <div
                  className="text-right shrink-0 text-xs text-black/60 dark:text-white/60 rounded px-1.5 py-1 -mx-1.5"
                  style={gradientBackground(listing.commute?.minutes, commuteMin, commuteMax)}
                >
                  {formatCommute(listing.commute)}
                </div>
              )}
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
