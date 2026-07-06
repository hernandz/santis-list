import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import type { Listing, Prisma } from "@/generated/prisma/client";
import { getNearestStations, type NearestStation } from "@/server/geo/transitStations";
import { getNeighborhoodForPoint } from "@/server/geo/neighborhoodBoundaries";
import {
  getCarCommutesBatch,
  getBikeCommutesBatch,
  getTransitCommute,
  usesGoogleTransit,
  mapWithConcurrency,
  COMMUTE_REQUEST_CONCURRENCY,
  type CommuteEstimate,
} from "@/server/geo/commute";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;
const MAP_LIMIT = 500;
// Sorting/filtering by walk-to-train time can't happen in SQL — nearestStation
// is computed live per listing, not a stored column — so that path fetches up
// to this many matching rows, enriches all of them, then sorts/filters/paginates
// in memory. Bounded so a huge result set can't blow up memory/latency.
const TRANSIT_SORT_CAP = 2000;
// Sorting by car commute needs the whole candidate pool's commute computed
// *before* pagination (not just the final page), via one batched OSRM table
// request. That request's coordinate list is bounded here — the public demo
// routing server isn't meant for huge batches, so this trades a smaller
// candidate pool for a request size that's actually reasonable to send it.
// Also applied to transit whenever a Google Maps key is configured — real
// transit lookups are one paid request per listing, not free/in-process like
// the heuristic fallback, so a huge page (e.g. the map's ~500 pins) shouldn't
// fire that many at once.
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
  minPrice: number | null;
  maxPrice: number | null;
  minBedrooms: number | null;
  minBathrooms: number | null;
}): Prisma.ListingWhereInput[] {
  const conditions: Prisma.ListingWhereInput[] = [{ city: watch.city }];
  if (watch.minPrice != null) conditions.push({ price: { gte: watch.minPrice } });
  if (watch.maxPrice != null) conditions.push({ price: { lte: watch.maxPrice } });
  if (watch.minBedrooms != null) conditions.push({ bedrooms: { gte: watch.minBedrooms } });
  if (watch.minBathrooms != null) conditions.push({ bathrooms: { gte: watch.minBathrooms } });
  return conditions;
}

type WatchLike = {
  city: string;
  neighborhoods: string[];
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
): Promise<number> {
  const whereMissingLocation: Prisma.ListingWhereInput = {
    AND: [...sqlConditionsWithoutGeo, { OR: [{ latitude: null }, { longitude: null }] }],
  };

  const needsNeighborhoodCheck =
    adHocNeighborhoodNames.length > 0 || (scopeWatches?.some((w) => w.neighborhoods.length > 0) ?? false);

  if (!needsNeighborhoodCheck) {
    return prisma.listing.count({ where: whereMissingLocation });
  }

  const candidates = await prisma.listing.findMany({ where: whereMissingLocation, take: NOT_PLOTTED_CAP });

  return candidates.filter((listing) => {
    if (adHocNeighborhoodNames.length > 0 && !matchesNeighborhoods(listing, null, adHocNeighborhoodNames)) {
      return false;
    }
    if (scopeWatches != null) {
      if (scopeWatches.length === 0) return false;
      if (!scopeWatches.some((w) => watchMatchesEnrichedListing(w, listing, null))) return false;
    }
    return true;
  }).length;
}

async function enrichListing<T extends Listing>(
  listing: T,
): Promise<
  T & { nearestStation: NearestStation | null; nextStation: NearestStation | null; boundaryNeighborhood: string | null }
> {
  const hasGeo = listing.latitude != null && listing.longitude != null;
  const [nearestStations, boundaryNeighborhood] = await Promise.all([
    hasGeo
      ? getNearestStations(listing.city, listing.latitude!, listing.longitude!, NEXT_STATION_CANDIDATE_POOL)
      : [],
    hasGeo ? getNeighborhoodForPoint(listing.city, listing.latitude!, listing.longitude!) : null,
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

// Only computed for the current page of results (never the whole candidate
// pool) — car/bike commutes each cost one batched external routing request
// per page, and there's no reason to spend that on rows the user isn't
// looking at.
async function attachCommute<T extends Listing>(
  listings: T[],
  mode: "car" | "bike" | "transit",
  work: { latitude: number; longitude: number },
): Promise<(T & { commute: CommuteEstimate | null })[]> {
  const withGeo = listings.filter((l) => l.latitude != null && l.longitude != null);

  if (mode === "car" || mode === "bike") {
    const batchFn = mode === "car" ? getCarCommutesBatch : getBikeCommutesBatch;
    const commutes = await batchFn(
      withGeo.map((l) => ({ latitude: l.latitude!, longitude: l.longitude! })),
      work,
    );
    const byId = new Map(withGeo.map((l, i) => [l.id, commutes[i]]));
    return listings.map((l) => ({ ...l, commute: byId.get(l.id) ?? null }));
  }

  // Each listing's own city (not a single page-level filter) — results can
  // span cities when no city filter is active. Only capped when transit
  // means a real paid Google lookup per listing — the free heuristic
  // fallback has no reason to limit how many it covers.
  const transitBatch = usesGoogleTransit() ? withGeo.slice(0, COMMUTE_EXTERNAL_API_CAP) : withGeo;
  const commutes = await mapWithConcurrency(transitBatch, COMMUTE_REQUEST_CONCURRENCY, (l) =>
    getTransitCommute(l.city, { latitude: l.latitude!, longitude: l.longitude! }, work),
  );
  const byId = new Map(transitBatch.map((l, i) => [l.id, commutes[i]]));
  return listings.map((l) => ({ ...l, commute: byId.get(l.id) ?? null }));
}

// Used by the map view, which shows every mode per listing at once rather
// than letting the user pick one. Car/bike each need one batched OSRM
// request, so each is capped (see COMMUTE_EXTERNAL_API_CAP) — a map of ~500
// pins is more than either request is meant for. Transit is capped the same
// way only when it's a real per-listing Google lookup, not the free
// in-process heuristic.
async function attachAllCommutes<T extends Listing>(
  listings: T[],
  work: { latitude: number; longitude: number },
): Promise<
  (T & { commuteCar: CommuteEstimate | null; commuteBike: CommuteEstimate | null; commuteTransit: CommuteEstimate | null })[]
> {
  const withGeo = listings.filter((l) => l.latitude != null && l.longitude != null);
  const carBatch = withGeo.slice(0, COMMUTE_EXTERNAL_API_CAP);
  const bikeBatch = withGeo.slice(0, COMMUTE_EXTERNAL_API_CAP);
  const transitBatch = usesGoogleTransit() ? withGeo.slice(0, COMMUTE_EXTERNAL_API_CAP) : withGeo;

  const [carCommutes, bikeCommutes, transitCommutes] = await Promise.all([
    getCarCommutesBatch(
      carBatch.map((l) => ({ latitude: l.latitude!, longitude: l.longitude! })),
      work,
    ),
    getBikeCommutesBatch(
      bikeBatch.map((l) => ({ latitude: l.latitude!, longitude: l.longitude! })),
      work,
    ),
    mapWithConcurrency(transitBatch, COMMUTE_REQUEST_CONCURRENCY, (l) =>
      getTransitCommute(l.city, { latitude: l.latitude!, longitude: l.longitude! }, work),
    ),
  ]);

  const carById = new Map(carBatch.map((l, i) => [l.id, carCommutes[i]]));
  const bikeById = new Map(bikeBatch.map((l, i) => [l.id, bikeCommutes[i]]));
  const transitById = new Map(transitBatch.map((l, i) => [l.id, transitCommutes[i]]));

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
) {
  return mode === "both" ? attachAllCommutes(listings, work) : attachCommute(listings, mode, work);
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

    const [total, listings, notPlotted] = await Promise.all([
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
      commuteMode && work ? await attachCommuteAny(listingsEnriched, commuteMode, work) : listingsEnriched;

    return NextResponse.json(
      {
        listings: listingsWithCommute,
        page,
        pageSize: forMap ? MAP_LIMIT : PAGE_SIZE,
        total,
        totalPages: forMap ? 1 : Math.max(1, Math.ceil(total / PAGE_SIZE)),
        ...(forMap ? { totalRegardlessOfLocation: total + (notPlotted ?? 0), notPlotted: notPlotted ?? 0 } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // Transit-aware path: pull a capped, broad set matching the SQL-level filters,
  // enrich all of them with live nearestStation data, then apply the walk-time
  // filter/sort and paginate in memory.
  const usesExternalCommuteApi =
    sortingByCommute &&
    (commuteMode === "car" || commuteMode === "bike" || (commuteMode === "transit" && usesGoogleTransit()));
  const candidateCap = usesExternalCommuteApi ? COMMUTE_EXTERNAL_API_CAP : TRANSIT_SORT_CAP;
  const [whereTotal, candidates, notPlotted] = await Promise.all([
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
    ? await attachCommute(enrichedBase, commuteMode!, work!)
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
    !sortingByCommute && commuteMode && work ? await attachCommuteAny(paged, commuteMode, work) : paged;

  return NextResponse.json(
    {
      listings: pagedWithCommute,
      page,
      pageSize: forMap ? MAP_LIMIT : PAGE_SIZE,
      total,
      totalPages: forMap ? 1 : Math.max(1, Math.ceil(total / PAGE_SIZE)),
      truncated,
      ...(forMap ? { totalRegardlessOfLocation: total + (notPlotted ?? 0), notPlotted: notPlotted ?? 0 } : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
