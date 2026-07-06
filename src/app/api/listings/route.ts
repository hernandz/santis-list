import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import type { Listing, Prisma } from "@/generated/prisma/client";
import { getNearestStations, type NearestStation } from "@/server/geo/transitStations";
import { getNeighborhoodForPoint } from "@/server/geo/neighborhoodBoundaries";
import {
  getCarCommutesBatch,
  getBikeCommutesBatch,
  getTransitCommute,
  usesGoogleRouting,
  mapWithConcurrency,
  COMMUTE_REQUEST_CONCURRENCY,
  type CommuteEstimate,
} from "@/server/geo/commute";
import { getCachedCommutes, saveCommutes } from "@/server/geo/commuteCache";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;
const MAP_LIMIT = 500;
// Sorting/filtering by walk-to-train time, train lines, or neighborhood can't
// happen in SQL — each is computed live per listing, not a stored column —
// so that path fetches up to this many matching rows, enriches all of them,
// then sorts/filters/paginates in memory. All free/local computation (no
// external API), so this is purely a memory/latency safety net, set well
// above any realistic real listing count rather than a meaningful limit.
const TRANSIT_SORT_CAP = 20000;
// Only applies when a mode is actually using the paid Google Directions API
// (see usesGoogleRouting) — real lookups cost money past the free tier, so a
// huge page (e.g. the map's ~500 pins, or sorting by commute across
// thousands of listings) shouldn't fire that many paid requests at once.
// The free alternatives (OSRM for car/bike, a walk-to-station heuristic for
// transit) have no such limit — OSRM's request is chunked instead (see
// commute.ts) so it stays safe at any size, and the heuristic never leaves
// the process at all.
const COMMUTE_EXTERNAL_API_CAP = 300;
// A second, further station is only worth surfacing if it's still a
// reasonable walk — otherwise it's just noise.
const NEXT_STATION_MAX_WALK_MINUTES = 20;
// How many nearest candidates to scan looking for one on a different line —
// another stop on the SAME line as the nearest station isn't a useful second
// option, so we look a bit further down the sorted-by-distance list for one
// that actually offers a different line.
const NEXT_STATION_CANDIDATE_POOL = 6;

function parseNumber(value: string | null): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
}

// A listing matches a target neighborhood name if EITHER its raw Craigslist
// text mentions it OR its real coordinates verify it (boundaryNeighborhood,
// computed via point-in-polygon) — text alone isn't reliable, since posters
// often label a listing with a nearby/informal name (e.g. "Ridgewood") even
// when the verified neighborhood is something else (e.g. "Bushwick (West)").
// Matching text-only would silently miss real matches like that.
function matchesNeighborhoods(
  listing: { locationText: string | null; title: string },
  boundaryNeighborhood: string | null,
  names: string[],
): boolean {
  return names.some((n) => {
    const needle = n.toLowerCase();
    if (listing.locationText?.toLowerCase().includes(needle)) return true;
    if (listing.title.toLowerCase().includes(needle)) return true;
    if (boundaryNeighborhood && boundaryNeighborhood.toLowerCase() === needle) return true;
    return false;
  });
}

// SQL-safe subset of a watch's criteria (city/price/bed/bath) — used only to
// broadly scope the candidate query. Neighborhoods are deliberately excluded
// here since boundaryNeighborhood is computed live per point, not a stored
// column — see watchMatchesEnrichedListing for the full, accurate check.
function watchSqlConditions(watch: {
  city: string;
  keyword: string | null;
  minPrice: number | null;
  maxPrice: number | null;
  minBedrooms: number | null;
  minBathrooms: number | null;
}): Prisma.ListingWhereInput[] {
  const conditions: Prisma.ListingWhereInput[] = [{ city: watch.city }];
  if (watch.keyword) conditions.push({ title: { contains: watch.keyword, mode: "insensitive" } });
  if (watch.minPrice != null) conditions.push({ price: { gte: watch.minPrice } });
  if (watch.maxPrice != null) conditions.push({ price: { lte: watch.maxPrice } });
  if (watch.minBedrooms != null) conditions.push({ bedrooms: { gte: watch.minBedrooms } });
  if (watch.minBathrooms != null) conditions.push({ bathrooms: { gte: watch.minBathrooms } });
  return conditions;
}

type WatchLike = {
  city: string;
  neighborhoods: string[];
  keyword: string | null;
  minPrice: number | null;
  maxPrice: number | null;
  minBedrooms: number | null;
  minBathrooms: number | null;
};

// The full, accurate per-watch check (re-validated in JS since the SQL query
// only scoped candidates broadly across possibly-multiple OR'd watches).
function watchMatchesEnrichedListing(
  watch: WatchLike,
  listing: { city: string; price: number | null; bedrooms: number | null; bathrooms: number | null; locationText: string | null; title: string },
  boundaryNeighborhood: string | null,
): boolean {
  if (listing.city !== watch.city) return false;
  if (watch.keyword && !listing.title.toLowerCase().includes(watch.keyword.toLowerCase())) return false;
  if (watch.minPrice != null && (listing.price == null || listing.price < watch.minPrice)) return false;
  if (watch.maxPrice != null && (listing.price == null || listing.price > watch.maxPrice)) return false;
  if (watch.minBedrooms != null && (listing.bedrooms == null || listing.bedrooms < watch.minBedrooms)) return false;
  if (watch.minBathrooms != null && (listing.bathrooms == null || listing.bathrooms < watch.minBathrooms)) return false;
  if (watch.neighborhoods.length > 0 && !matchesNeighborhoods(listing, boundaryNeighborhood, watch.neighborhoods)) {
    return false;
  }
  return true;
}

// A listing missing lat/lon can never be boundary-checked, so it only ever
// matches a neighborhood-restricted search via the text fallback in
// matchesNeighborhoods (boundaryNeighborhood is always null here, deliberately).
// Bounded the same way the transit-aware path is — a huge "missing location"
// pool is unlikely, but this avoids pulling an unbounded set into memory.
const NOT_PLOTTED_CAP = 2000;

async function countNotPlotted(
  sqlConditionsWithoutGeo: Prisma.ListingWhereInput[],
  adHocNeighborhoodNames: string[],
  scopeWatches: WatchLike[] | null,
): Promise<{ count: number; truncated: boolean }> {
  const whereMissingLocation: Prisma.ListingWhereInput = {
    AND: [...sqlConditionsWithoutGeo, { OR: [{ latitude: null }, { longitude: null }] }],
  };

  const needsNeighborhoodCheck =
    adHocNeighborhoodNames.length > 0 || (scopeWatches?.some((w) => w.neighborhoods.length > 0) ?? false);

  if (!needsNeighborhoodCheck) {
    const count = await prisma.listing.count({ where: whereMissingLocation });
    return { count, truncated: false };
  }

  // The JS-filtered count below only ever looks at the first NOT_PLOTTED_CAP
  // candidates — if the real total exceeds that, the count can undercount
  // (some listing past the cap might have matched too) with no indication
  // anything was cut off. This exact count is cheap (one indexed COUNT) and
  // lets the caller surface that honestly instead of silently.
  const [exactTotal, candidates] = await Promise.all([
    prisma.listing.count({ where: whereMissingLocation }),
    prisma.listing.findMany({ where: whereMissingLocation, take: NOT_PLOTTED_CAP }),
  ]);

  const count = candidates.filter((listing) => {
    if (adHocNeighborhoodNames.length > 0 && !matchesNeighborhoods(listing, null, adHocNeighborhoodNames)) {
      return false;
    }
    if (scopeWatches != null) {
      if (scopeWatches.length === 0) return false;
      if (!scopeWatches.some((w) => watchMatchesEnrichedListing(w, listing, null))) return false;
    }
    return true;
  }).length;

  return { count, truncated: exactTotal > NOT_PLOTTED_CAP };
}

async function enrichListing<T extends Listing>(
  listing: T,
): Promise<
  T & { nearestStation: NearestStation | null; nextStation: NearestStation | null; boundaryNeighborhood: string | null }
> {
  const hasGeo = listing.latitude != null && listing.longitude != null;
  // boundaryNeighborhood is stored on the row now (set once at crawl time —
  // see the schema comment) — only fall back to a live lookup for the rare
  // listing that has geo but hasn't been backfilled/classified yet.
  const [nearestStations, boundaryNeighborhood] = await Promise.all([
    hasGeo
      ? getNearestStations(listing.city, listing.latitude!, listing.longitude!, NEXT_STATION_CANDIDATE_POOL)
      : [],
    listing.boundaryNeighborhood ?? (hasGeo ? getNeighborhoodForPoint(listing.city, listing.latitude!, listing.longitude!) : null),
  ]);

  const [nearestStation, ...rest] = nearestStations;
  const nearestLineNames = new Set((nearestStation?.lines ?? []).map((l) => l.name));
  const differentLineStation = rest.find((s) => s.lines.some((l) => !nearestLineNames.has(l.name)));
  // Only show the lines this station adds beyond the nearest one — a transfer
  // hub that also happens to share the nearest station's line shouldn't repeat
  // that badge, since it's not a new option.
  const nextStation =
    differentLineStation && differentLineStation.walkingMinutes <= NEXT_STATION_MAX_WALK_MINUTES
      ? { ...differentLineStation, lines: differentLineStation.lines.filter((l) => !nearestLineNames.has(l.name)) }
      : null;

  return { ...listing, nearestStation: nearestStation ?? null, nextStation, boundaryNeighborhood };
}

// Shared by attachCommute/attachAllCommutes below. Checks the persistent
// CommuteCache first (see commuteCache.ts) — a listing's coordinates never
// change once geocoded, so the same (listing, mode) pair only ever needs a
// real external lookup once. Only the cache-miss subset is sent to the live
// batch fn, capped at `cap` rows (null = uncapped, for the free heuristic
// transit fallback, which costs nothing external). Because the cap applies
// to the uncached subset rather than the whole candidate pool, repeated
// requests for the same pool (re-sorting, re-paging, reopening the map)
// progressively cover more of it for free instead of always re-spending the
// live-request budget on the same leading slice.
async function resolveCommutes<T extends Listing>(
  listings: T[],
  mode: "car" | "bike" | "transit",
  work: { latitude: number; longitude: number },
  cap: number | null,
  useGoogle: boolean,
): Promise<Map<string, CommuteEstimate | null>> {
  const cached = await getCachedCommutes(
    listings.map((l) => l.id),
    mode,
    work,
  );
  const uncached = listings.filter((l) => !cached.has(l.id));
  const live = cap != null ? uncached.slice(0, cap) : uncached;

  const commutes =
    mode === "car"
      ? await getCarCommutesBatch(
          live.map((l) => ({ latitude: l.latitude!, longitude: l.longitude! })),
          work,
          useGoogle,
        )
      : mode === "bike"
        ? await getBikeCommutesBatch(
            live.map((l) => ({ latitude: l.latitude!, longitude: l.longitude! })),
            work,
            useGoogle,
          )
        : await mapWithConcurrency(live, COMMUTE_REQUEST_CONCURRENCY, (l) =>
            getTransitCommute(l.city, { latitude: l.latitude!, longitude: l.longitude! }, work, useGoogle),
          );

  const freshEntries = live
    .map((l, i) => ({ listingId: l.id, mode, estimate: commutes[i] }))
    .filter((e): e is { listingId: string; mode: typeof mode; estimate: CommuteEstimate } => e.estimate != null);
  await saveCommutes(freshEntries, work);

  const result = new Map<string, CommuteEstimate | null>(cached);
  live.forEach((l, i) => result.set(l.id, commutes[i]));
  return result;
}

// Only computed for the current page of results (never the whole candidate
// pool) — car/bike commutes each cost one batched external routing request
// per page, and there's no reason to spend that on rows the user isn't
// looking at.
async function attachCommute<T extends Listing>(
  listings: T[],
  mode: "car" | "bike" | "transit",
  work: { latitude: number; longitude: number },
  useGoogle: boolean,
): Promise<(T & { commute: CommuteEstimate | null })[]> {
  const withGeo = listings.filter((l) => l.latitude != null && l.longitude != null);

  // Only capped when this mode is actually using the paid Google API — the
  // free alternatives (OSRM for car/bike, the heuristic for transit) have no
  // reason to limit how many listings they cover.
  const cap = usesGoogleRouting(useGoogle) ? COMMUTE_EXTERNAL_API_CAP : null;
  const byId = await resolveCommutes(withGeo, mode, work, cap, useGoogle);
  return listings.map((l) => ({ ...l, commute: byId.get(l.id) ?? null }));
}

// Used by the map view, which shows every mode per listing at once rather
// than letting the user pick one. Each is capped the same way as attachCommute
// above — only when it's actually the paid Google API, not the free
// OSRM/heuristic fallbacks.
async function attachAllCommutes<T extends Listing>(
  listings: T[],
  work: { latitude: number; longitude: number },
  useGoogle: boolean,
): Promise<
  (T & { commuteCar: CommuteEstimate | null; commuteBike: CommuteEstimate | null; commuteTransit: CommuteEstimate | null })[]
> {
  const withGeo = listings.filter((l) => l.latitude != null && l.longitude != null);
  const cap = usesGoogleRouting(useGoogle) ? COMMUTE_EXTERNAL_API_CAP : null;

  const [carById, bikeById, transitById] = await Promise.all([
    resolveCommutes(withGeo, "car", work, cap, useGoogle),
    resolveCommutes(withGeo, "bike", work, cap, useGoogle),
    resolveCommutes(withGeo, "transit", work, cap, useGoogle),
  ]);

  return listings.map((l) => ({
    ...l,
    commuteCar: carById.get(l.id) ?? null,
    commuteBike: bikeById.get(l.id) ?? null,
    commuteTransit: transitById.get(l.id) ?? null,
  }));
}

async function attachCommuteAny<T extends Listing>(
  listings: T[],
  mode: "car" | "bike" | "transit" | "both",
  work: { latitude: number; longitude: number },
  useGoogle: boolean,
) {
  return mode === "both"
    ? attachAllCommutes(listings, work, useGoogle)
    : attachCommute(listings, mode, work, useGoogle);
}

function medianRentGroupKey(city: string, neighborhood: string, bedrooms: number): string {
  return `${city}|${neighborhood}|${bedrooms}`;
}

type RentStats = { median: number; min: number; max: number };

// Real min/median/max across every listing (not just what's on screen)
// sharing the same city + verified neighborhood + bedroom count — one
// batched query (via unnest, not one query per distinct group) covering
// every group present on the current page at once. Deliberately not further
// split by bathrooms — that fragmented groups down to 1-2 comparable
// listings each (e.g. a specific neighborhood's only 1bd/1ba), too sparse to
// mean anything; bedroom count is the dimension that actually drives rent
// comparison shopping. Only ever computed for listings with a verified
// boundaryNeighborhood and a known bedroom count — missing either just means
// no stats (and the client shows no color at all rather than guessing).
async function getRentStats(
  groups: { city: string; neighborhood: string; bedrooms: number }[],
): Promise<Map<string, RentStats>> {
  if (groups.length === 0) return new Map();

  const rows = await prisma.$queryRaw<
    { city: string; neighborhood: string; bedrooms: number; median: number; min: number; max: number }[]
  >`
    SELECT g.city, g.neighborhood, g.bedrooms,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY l.price) AS median,
           MIN(l.price) AS min,
           MAX(l.price) AS max
    FROM unnest(
      ${groups.map((g) => g.city)}::text[],
      ${groups.map((g) => g.neighborhood)}::text[],
      ${groups.map((g) => g.bedrooms)}::int[]
    ) AS g(city, neighborhood, bedrooms)
    JOIN "Listing" l
      ON l.city = g.city
      AND l."boundaryNeighborhood" = g.neighborhood
      AND l.bedrooms = g.bedrooms
    WHERE l.price IS NOT NULL
    GROUP BY g.city, g.neighborhood, g.bedrooms
  `;

  const map = new Map<string, RentStats>();
  for (const row of rows) {
    map.set(medianRentGroupKey(row.city, row.neighborhood, row.bedrooms), {
      median: Number(row.median),
      min: Number(row.min),
      max: Number(row.max),
    });
  }
  return map;
}

async function attachMedianRent<T extends Listing>(
  listings: T[],
): Promise<(T & { medianRent: number | null; minRent: number | null; maxRent: number | null })[]> {
  const seen = new Set<string>();
  const groups: { city: string; neighborhood: string; bedrooms: number }[] = [];
  for (const l of listings) {
    if (l.boundaryNeighborhood == null || l.bedrooms == null) continue;
    const key = medianRentGroupKey(l.city, l.boundaryNeighborhood, l.bedrooms);
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push({ city: l.city, neighborhood: l.boundaryNeighborhood, bedrooms: l.bedrooms });
  }

  const stats = await getRentStats(groups);
  return listings.map((l) => {
    if (l.boundaryNeighborhood == null || l.bedrooms == null) {
      return { ...l, medianRent: null, minRent: null, maxRent: null };
    }
    const key = medianRentGroupKey(l.city, l.boundaryNeighborhood, l.bedrooms);
    const s = stats.get(key);
    return { ...l, medianRent: s?.median ?? null, minRent: s?.min ?? null, maxRent: s?.max ?? null };
  });
}

function comparePrice(a: Listing, b: Listing, direction: "asc" | "desc"): number {
  const av = a.price ?? (direction === "asc" ? Infinity : -Infinity);
  const bv = b.price ?? (direction === "asc" ? Infinity : -Infinity);
  return direction === "asc" ? av - bv : bv - av;
}

// "Newest" means when Craigslist says the listing was posted, not when our
// crawler happened to discover it — those can differ by hours if a watch's
// search hasn't turned up anything new in a while. Listings missing a posted
// date (rare — happens if the detail-page fetch failed) sort to the end.
function comparePostedAt(a: Listing, b: Listing): number {
  const at = a.postedAt ? new Date(a.postedAt).getTime() : -Infinity;
  const bt = b.postedAt ? new Date(b.postedAt).getTime() : -Infinity;
  return bt - at;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const city = searchParams.get("city") || undefined;
  const keyword = searchParams.get("keyword") || undefined;
  const neighborhood = searchParams.get("neighborhood") || undefined;
  const neighborhoods = (searchParams.get("neighborhoods") ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  const minPrice = parseNumber(searchParams.get("minPrice"));
  const maxPrice = parseNumber(searchParams.get("maxPrice"));
  const minBedrooms = parseNumber(searchParams.get("minBedrooms"));
  const minBathrooms = parseNumber(searchParams.get("minBathrooms"));
  const maxWalkMinutes = parseNumber(searchParams.get("maxWalkMinutes"));
  const trainLines = (searchParams.get("trainLines") ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  const sort = searchParams.get("sort") || "newest";
  const page = Math.max(1, parseNumber(searchParams.get("page")) ?? 1);
  const forMap = searchParams.get("forMap") === "true";
  const useAllWatches = searchParams.get("useAllWatches") === "true";
  const watchId = searchParams.get("watchId") || undefined;
  const commuteModeParam = searchParams.get("commuteMode");
  const commuteMode =
    commuteModeParam === "car" ||
    commuteModeParam === "bike" ||
    commuteModeParam === "transit" ||
    commuteModeParam === "both"
      ? commuteModeParam
      : null;
  const workSettings = commuteMode ? await prisma.settings.findUnique({ where: { id: "singleton" } }) : null;
  const useGoogle = workSettings?.useGoogleDirections ?? false;
  const work =
    workSettings?.workLatitude != null && workSettings?.workLongitude != null
      ? { latitude: workSettings.workLatitude, longitude: workSettings.workLongitude }
      : null;

  const hasAdHocNeighborhoodFilter = Boolean(neighborhood) || neighborhoods.length > 0;
  const adHocNeighborhoodNames = neighborhood ? [neighborhood, ...neighborhoods] : neighborhoods;

  // Each condition is its own AND entry rather than a spread-merged object —
  // several of these (min/max price) would otherwise collide on the same
  // object key and silently clobber each other if more than one were active.
  // Neighborhood filtering is NEVER a SQL condition — boundaryNeighborhood is
  // computed live per point (see matchesNeighborhoods), so it's always
  // applied as a post-enrichment filter below instead.
  const conditions: Prisma.ListingWhereInput[] = [];
  if (city) conditions.push({ city });
  if (keyword) conditions.push({ title: { contains: keyword, mode: "insensitive" } });
  if (minPrice != null) conditions.push({ price: { gte: minPrice } });
  if (maxPrice != null) conditions.push({ price: { lte: maxPrice } });
  if (minBedrooms != null) conditions.push({ bedrooms: { gte: minBedrooms } });
  if (minBathrooms != null) conditions.push({ bathrooms: { gte: minBathrooms } });

  // Auto-apply every active saved search: a listing counts if it satisfies at
  // least one watch's full criteria (city + price + bed/bath + neighborhoods),
  // computed live against the watches' current settings — not dependent on
  // WatchMatch rows, which only accumulate and are never pruned as criteria change.
  // The SQL condition here only scopes broadly by city/price/bed/bath (a safe
  // superset); the exact match, including neighborhoods, is re-verified in JS
  // below via watchMatchesEnrichedListing once boundaryNeighborhood is known.
  let scopeWatches: WatchLike[] | null = null;
  if (useAllWatches) {
    const activeWatches = await prisma.watch.findMany({ where: { isActive: true } });
    scopeWatches = activeWatches;
    conditions.push(
      activeWatches.length > 0
        ? { OR: activeWatches.map((w) => ({ AND: watchSqlConditions(w) })) }
        : { id: "__none__" }, // no active watches → show nothing rather than everything
    );
  } else if (watchId) {
    // Scoped to one specific saved search's current criteria (not a stale
    // snapshot, and not dependent on previously-recorded WatchMatch rows).
    const watch = await prisma.watch.findUnique({ where: { id: watchId } });
    scopeWatches = watch ? [watch] : [];
    conditions.push(watch ? { AND: watchSqlConditions(watch) } : { id: "__none__" });
  }

  // A *copy* of conditions so far (city/price/bed-bath/scope, no neighborhood
  // text yet) — `conditions` is a mutable array and gets the geo requirement
  // pushed onto it next, so capturing a reference here (rather than a copy)
  // would silently pick that up too and defeat the whole point of this list.
  const sqlConditionsWithoutGeo = [...conditions];

  if (forMap) conditions.push({ latitude: { not: null }, longitude: { not: null } });
  const where: Prisma.ListingWhereInput = conditions.length > 0 ? { AND: conditions } : {};

  const scopeHasNeighborhoods = scopeWatches?.some((w) => w.neighborhoods.length > 0) ?? false;
  const sortingByCommute =
    sort === "commute" &&
    (commuteMode === "car" || commuteMode === "bike" || commuteMode === "transit") &&
    work != null;
  const needsEnrichedFilter =
    sort === "distance_to_train" ||
    maxWalkMinutes != null ||
    trainLines.length > 0 ||
    hasAdHocNeighborhoodFilter ||
    scopeHasNeighborhoods ||
    sortingByCommute;

  // Fast path: everything sortable/filterable in SQL, enrich only the current page.
  if (!needsEnrichedFilter) {
    const orderBy: Prisma.ListingOrderByWithRelationInput =
      sort === "price_asc"
        ? { price: "asc" }
        : sort === "price_desc"
          ? { price: "desc" }
          : { postedAt: { sort: "desc", nulls: "last" } };

    const skip = forMap ? 0 : (page - 1) * PAGE_SIZE;
    const take = forMap ? MAP_LIMIT : PAGE_SIZE;

    const [total, listings, notPlottedResult] = await Promise.all([
      prisma.listing.count({ where }),
      prisma.listing.findMany({
        where,
        orderBy,
        skip,
        take,
        include: { matches: { include: { watch: { select: { id: true, name: true } } } } },
      }),
      forMap ? countNotPlotted(sqlConditionsWithoutGeo, adHocNeighborhoodNames, scopeWatches) : Promise.resolve(null),
    ]);

    const listingsEnriched = await Promise.all(listings.map(enrichListing));
    const listingsWithCommute =
      commuteMode && work ? await attachCommuteAny(listingsEnriched, commuteMode, work, useGoogle) : listingsEnriched;
    const listingsWithMedian = await attachMedianRent(listingsWithCommute);

    return NextResponse.json(
      {
        listings: listingsWithMedian,
        page,
        pageSize: forMap ? MAP_LIMIT : PAGE_SIZE,
        total,
        totalPages: forMap ? 1 : Math.max(1, Math.ceil(total / PAGE_SIZE)),
        ...(forMap
          ? {
              totalRegardlessOfLocation: total + (notPlottedResult?.count ?? 0),
              notPlotted: notPlottedResult?.count ?? 0,
              notPlottedTruncated: notPlottedResult?.truncated ?? false,
            }
          : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // Transit-aware path: pull a capped, broad set matching the SQL-level filters,
  // enrich all of them with live nearestStation data, then apply the walk-time
  // filter/sort and paginate in memory. Tightly capped only when sorting by
  // commute AND actually paying for it (Google) — otherwise (including
  // sort-by-commute on the free OSRM/heuristic path) the much looser
  // TRANSIT_SORT_CAP applies, so sort genuinely covers the whole result set.
  const candidateCap = sortingByCommute && usesGoogleRouting(useGoogle) ? COMMUTE_EXTERNAL_API_CAP : TRANSIT_SORT_CAP;
  const [whereTotal, candidates, notPlottedResult] = await Promise.all([
    prisma.listing.count({ where }),
    prisma.listing.findMany({
      where,
      orderBy: { postedAt: { sort: "desc", nulls: "last" } },
      take: candidateCap,
      include: { matches: { include: { watch: { select: { id: true, name: true } } } } },
    }),
    forMap ? countNotPlotted(sqlConditionsWithoutGeo, adHocNeighborhoodNames, scopeWatches) : Promise.resolve(null),
  ]);
  const truncated = whereTotal > candidates.length;

  const enrichedBase = await Promise.all(candidates.map(enrichListing));
  // When sorting by commute, it has to be computed for the whole candidate
  // pool before pagination (not just the final page) — otherwise "closest
  // commute first" would only ever reorder within one page. Otherwise leave
  // commute unset here — it's attached to just the final page below instead.
  const enriched = sortingByCommute
    ? await attachCommute(enrichedBase, commuteMode!, work!, useGoogle)
    : enrichedBase.map((l) => ({ ...l, commute: null as CommuteEstimate | null }));

  let filtered = enriched;
  if (maxWalkMinutes != null) {
    filtered = filtered.filter((l) => l.nearestStation != null && l.nearestStation.walkingMinutes <= maxWalkMinutes);
  }
  if (trainLines.length > 0) {
    const wanted = new Set(trainLines);
    filtered = filtered.filter((l) => l.nearestStation?.lines.some((line) => wanted.has(line.name)) ?? false);
  }
  if (hasAdHocNeighborhoodFilter) {
    filtered = filtered.filter((l) => matchesNeighborhoods(l, l.boundaryNeighborhood, adHocNeighborhoodNames));
  }
  if (scopeWatches != null) {
    filtered =
      scopeWatches.length > 0
        ? filtered.filter((l) => scopeWatches!.some((w) => watchMatchesEnrichedListing(w, l, l.boundaryNeighborhood)))
        : [];
  }

  const sorted = filtered.slice().sort((a, b) => {
    if (sort === "distance_to_train") {
      const da = a.nearestStation?.distanceMiles ?? Infinity;
      const db = b.nearestStation?.distanceMiles ?? Infinity;
      return da - db;
    }
    if (sortingByCommute) {
      const ca = a.commute?.minutes ?? Infinity;
      const cb = b.commute?.minutes ?? Infinity;
      return ca - cb;
    }
    if (sort === "price_asc") return comparePrice(a, b, "asc");
    if (sort === "price_desc") return comparePrice(a, b, "desc");
    return comparePostedAt(a, b);
  });

  const total = sorted.length;
  const start = forMap ? 0 : (page - 1) * PAGE_SIZE;
  const end = forMap ? MAP_LIMIT : start + PAGE_SIZE;
  const paged = sorted.slice(start, end);
  // Already attached above (for the whole pool, ahead of sorting) when
  // sorting by commute — only needs attaching here for the final page when
  // commute is just being displayed, not sorted by.
  const pagedWithCommute =
    !sortingByCommute && commuteMode && work ? await attachCommuteAny(paged, commuteMode, work, useGoogle) : paged;
  const pagedWithMedian = await attachMedianRent(pagedWithCommute);

  return NextResponse.json(
    {
      listings: pagedWithMedian,
      page,
      pageSize: forMap ? MAP_LIMIT : PAGE_SIZE,
      total,
      totalPages: forMap ? 1 : Math.max(1, Math.ceil(total / PAGE_SIZE)),
      truncated,
      ...(forMap
        ? {
            totalRegardlessOfLocation: total + (notPlottedResult?.count ?? 0),
            notPlotted: notPlottedResult?.count ?? 0,
            notPlottedTruncated: notPlottedResult?.truncated ?? false,
          }
        : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
