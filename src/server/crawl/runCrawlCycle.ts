import { prisma } from "@/server/db/prisma";
import type { Listing, Watch } from "@/generated/prisma/client";
import { emailChannel } from "@/server/notify/email";
import type { NotificationListingPayload } from "@/server/notify/types";
import { getNotificationExtras, type WorkLocation } from "@/server/notify/commuteEnrichment";
import { buildPauseUrl } from "@/lib/pauseToken";
import { getNeighborhoodForPoint } from "@/server/geo/neighborhoodBoundaries";
import { craigslistSource } from "./sources/craigslist";
import type { ListingSource, RawListing } from "./sources/types";

const sources: Record<"CRAIGSLIST", ListingSource> = {
  CRAIGSLIST: craigslistSource,
};

export type CrawlCycleSummary = {
  watchesProcessed: number;
  watchesFailed: number;
  listingsSeen: number;
  newListings: number;
  matchesCreated: number;
  immediateNotificationsSent: number;
};

function passesThresholds(
  watch: { minBedrooms: number | null; minBathrooms: number | null },
  listing: { bedrooms: number | null; bathrooms: number | null },
): boolean {
  if (watch.minBedrooms != null && (listing.bedrooms == null || listing.bedrooms < watch.minBedrooms)) {
    return false;
  }
  if (watch.minBathrooms != null && (listing.bathrooms == null || listing.bathrooms < watch.minBathrooms)) {
    return false;
  }
  return true;
}

function passesKeyword(watch: { keyword: string | null }, listing: { title: string }): boolean {
  if (!watch.keyword) return true;
  return listing.title.toLowerCase().includes(watch.keyword.toLowerCase());
}

// Verifies a listing's real coordinates actually fall inside one of the watch's
// selected neighborhood polygons, rather than trusting Craigslist's own text
// search alone. If the listing has no verified boundaryNeighborhood (either no
// map coordinates at all, or not yet backfilled), we fall back to trusting the
// text-search match rather than silently dropping otherwise-real matches.
function passesNeighborhoodBoundary(watch: Watch, listing: Listing): boolean {
  if (watch.neighborhoods.length === 0) return true;
  if (listing.boundaryNeighborhood == null) return true;
  return watch.neighborhoods.includes(listing.boundaryNeighborhood);
}

// Cache of in-flight/completed searches for one crawl cycle, keyed by the exact
// (city, subarea, price range) tuple. Different watches that happen to share
// a city/subarea + price range hit Craigslist once instead of once per watch.
type SearchCache = Map<string, Promise<RawListing[]>>;

function searchCacheKey(city: string, subarea: string | null, minPrice: number | null, maxPrice: number | null): string {
  return JSON.stringify({ city, subarea, minPrice, maxPrice });
}

function cachedSearch(
  source: ListingSource,
  cache: SearchCache,
  criteria: { city: string; subarea?: string | null; minPrice: number | null; maxPrice: number | null },
): Promise<RawListing[]> {
  const key = searchCacheKey(criteria.city, criteria.subarea ?? null, criteria.minPrice, criteria.maxPrice);
  const cached = cache.get(key);
  if (cached) return cached;

  const promise = source.search(criteria).catch((err) => {
    // Evict a failed search immediately so the next watch sharing this exact
    // tuple gets a fresh attempt instead of silently inheriting this same
    // rejection for the rest of the cycle — a caller that already grabbed
    // this promise reference still sees the original failure (their own
    // per-watch try/catch in processWatch already isolates that), but
    // nothing after this point stays poisoned by it.
    cache.delete(key);
    throw err;
  });
  cache.set(key, promise);
  return promise;
}

// Craigslist's sub-area codes (e.g. "brk", "mnh") are an exact enum it
// recognizes directly, unlike free-text neighborhood keywords — so unlike the
// old per-neighborhood query= search, issuing one search per subarea and
// merging is reliable rather than fragile. This is purely a crawl-scope
// optimization: it narrows Craigslist's own recency-capped result window per
// search, it does not itself determine neighborhood matches.
async function searchAllSubareas(source: ListingSource, watch: Watch, cache: SearchCache): Promise<RawListing[]> {
  if (watch.subareas.length === 0) {
    return cachedSearch(source, cache, { city: watch.city, minPrice: watch.minPrice, maxPrice: watch.maxPrice });
  }

  const byExternalId = new Map<string, RawListing>();
  for (const subarea of watch.subareas) {
    const results = await cachedSearch(source, cache, {
      city: watch.city,
      subarea,
      minPrice: watch.minPrice,
      maxPrice: watch.maxPrice,
    });
    for (const raw of results) byExternalId.set(raw.externalId, raw);
  }
  return Array.from(byExternalId.values());
}

let inProgress = false;
let lastResult: { summary: CrawlCycleSummary; finishedAt: Date; failed: boolean; error?: string } | null = null;
let progress: { total: number; done: number; currentWatchName: string | null } | null = null;

export function isCrawlInProgress(): boolean {
  return inProgress;
}

export function getLastCrawlResult() {
  return lastResult;
}

export function getCrawlProgress() {
  return progress;
}

export async function runCrawlCycle(): Promise<CrawlCycleSummary> {
  if (inProgress) {
    throw new Error("A crawl cycle is already in progress");
  }
  inProgress = true;
  try {
    const summary = await runCrawlCycleUnguarded();
    lastResult = { summary, finishedAt: new Date(), failed: false };
    return summary;
  } catch (err) {
    lastResult = {
      summary: { watchesProcessed: 0, watchesFailed: 0, listingsSeen: 0, newListings: 0, matchesCreated: 0, immediateNotificationsSent: 0 },
      finishedAt: new Date(),
      failed: true,
      error: err instanceof Error ? err.message : String(err),
    };
    throw err;
  } finally {
    inProgress = false;
    progress = null;
  }
}

async function runCrawlCycleUnguarded(): Promise<CrawlCycleSummary> {
  const watches = await prisma.watch.findMany({ where: { isActive: true }, include: { profile: true } });
  const searchCache: SearchCache = new Map();

  // Deployment-wide fallback commute origin/billing toggle — per-watch
  // alert email and (optionally) work address instead come from the
  // watch's own Profile, fetched above alongside each watch.
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const defaultWork: WorkLocation | null =
    settings?.workLatitude != null && settings?.workLongitude != null
      ? { latitude: settings.workLatitude, longitude: settings.workLongitude }
      : null;
  const useGoogle = settings?.useGoogleDirections ?? false;

  const summary: CrawlCycleSummary = {
    watchesProcessed: 0,
    watchesFailed: 0,
    listingsSeen: 0,
    newListings: 0,
    matchesCreated: 0,
    immediateNotificationsSent: 0,
  };

  let done = 0;
  for (const watch of watches) {
    progress = { total: watches.length, done, currentWatchName: watch.name };
    // One watch's failure (bad city, transient network error, CL rate limiting, ...)
    // must not stop the rest of the active watches from being crawled.
    try {
      const work: WorkLocation | null =
        watch.profile?.workLatitude != null && watch.profile?.workLongitude != null
          ? { latitude: watch.profile.workLatitude, longitude: watch.profile.workLongitude }
          : defaultWork;
      await processWatch(watch, summary, searchCache, work, useGoogle, watch.profile?.email ?? null);
      summary.watchesProcessed += 1;
    } catch (err) {
      summary.watchesFailed += 1;
      console.error(`Crawl failed for watch "${watch.name}" (${watch.id}):`, err);
    }
    done += 1;
    progress = { total: watches.length, done, currentWatchName: watch.name };
  }

  return summary;
}

async function processWatch(
  watch: Watch,
  summary: CrawlCycleSummary,
  searchCache: SearchCache,
  work: WorkLocation | null,
  useGoogle: boolean,
  alertEmail: string | null,
): Promise<void> {
  const source = sources.CRAIGSLIST;
  // Search by subarea (if set) or the whole city, then rely on
  // passesNeighborhoodBoundary (real polygon geometry) to attribute listings
  // to neighborhoods, rather than Craigslist's own query= text search — that
  // breaks for official boundary names real posters never write, e.g.
  // "Bushwick (East)"/"(West)".
  const rawListings = await searchAllSubareas(source, watch, searchCache);
  summary.listingsSeen += rawListings.length;

  // One batched lookup instead of one findUnique per raw listing — with a
  // few hundred results per search this turns hundreds of sequential
  // round-trips into a single query (benchmarked: ~600 sequential
  // findUnique calls ≈ 250ms vs. ~15ms for one findMany).
  const existingListings = await prisma.listing.findMany({
    where: { source: "CRAIGSLIST", externalId: { in: rawListings.map((r) => r.externalId) } },
  });
  const existingByExternalId = new Map(existingListings.map((l) => [l.externalId, l]));

  const resolvedListings: Listing[] = [];
  for (const raw of rawListings) {
    let listing = existingByExternalId.get(raw.externalId);
    const isNewListing = !listing;

    if (isNewListing) {
      listing = await prisma.listing.create({
        data: {
          source: "CRAIGSLIST",
          externalId: raw.externalId,
          url: raw.url,
          title: raw.title,
          price: raw.price,
          locationText: raw.locationText,
          city: raw.city,
        },
      });
      summary.newListings += 1;
    }

    // Retry detail enrichment for brand-new listings, and for existing ones
    // that never picked it up — postedAt is only ever set by a successful
    // fetchDetails call, so a listing still missing it almost always means
    // an earlier attempt failed transiently, not that the page genuinely has
    // no posting date. Without this retry, one bad network blip on first
    // sight permanently excluded a listing from every bedroom/bathroom-
    // filtered watch, since passesThresholds treats null as "doesn't meet
    // the minimum" with no automatic recovery. Bounded by the same global
    // rate limiter as every other request — if Craigslist's detail-page
    // markup changed in a way that broke parsing entirely, this would retry
    // every affected listing every cycle rather than just once, which is the
    // right tradeoff (still-serialized, still-rate-limited) for not silently
    // losing matches forever.
    if (isNewListing || listing!.postedAt == null) {
      try {
        const details = await source.fetchDetails(raw.url);
        // Computed once, right when lat/lng first become known, and never
        // recomputed — see the schema comment on Listing.boundaryNeighborhood.
        const boundaryNeighborhood =
          details.latitude != null && details.longitude != null
            ? await getNeighborhoodForPoint(raw.city, details.latitude, details.longitude)
            : null;
        listing = await prisma.listing.update({
          where: { id: listing!.id },
          data: {
            bedrooms: details.bedrooms,
            bathrooms: details.bathrooms,
            postedAt: details.postedAt,
            address: details.address,
            latitude: details.latitude,
            longitude: details.longitude,
            boundaryNeighborhood,
          },
        });
      } catch (err) {
        console.error(`Failed to fetch details for ${raw.url}:`, err);
      }
    }

    resolvedListings.push(listing!);
  }

  const candidates: Listing[] = [];
  for (const listing of resolvedListings) {
    if (!passesThresholds(watch, listing)) continue;
    if (!passesKeyword(watch, listing)) continue;
    if (!passesNeighborhoodBoundary(watch, listing)) continue;
    candidates.push(listing);
  }

  // Same batching idea for the "already matched?" check — one query for all
  // of this watch's candidates instead of one per candidate.
  const existingMatches = await prisma.watchMatch.findMany({
    where: { watchId: watch.id, listingId: { in: candidates.map((l) => l.id) } },
  });
  const alreadyMatchedIds = new Set(existingMatches.map((m) => m.listingId));
  const newMatches = candidates.filter((l) => !alreadyMatchedIds.has(l.id));

  const immediateMatches: NotificationListingPayload[] = [];

  if (newMatches.length > 0) {
    await prisma.watchMatch.createMany({
      data: newMatches.map((listing) => ({ watchId: watch.id, listingId: listing.id })),
    });
    summary.matchesCreated += newMatches.length;

    // No profile (no one asked for alerts on this search) means there's no
    // point computing commute/station extras for an email that'll never be
    // sent — the search still crawls/matches for browsing regardless.
    if (watch.notifyFrequency === "IMMEDIATE" && alertEmail) {
      for (const listing of newMatches) {
        const extras = await getNotificationExtras(listing, work, useGoogle);
        immediateMatches.push({
          title: listing.title,
          url: listing.url,
          price: listing.price,
          bedrooms: listing.bedrooms,
          bathrooms: listing.bathrooms,
          locationText: listing.locationText,
          nearestStation: extras.nearestStation,
          commute: extras.commute,
        });
      }
    }
  }

  if (immediateMatches.length > 0 && alertEmail) {
    const notification = await prisma.notification.create({
      data: {
        watchId: watch.id,
        channel: "EMAIL",
        type: "IMMEDIATE",
        status: "PENDING",
      },
    });

    try {
      await emailChannel.send({
        to: alertEmail,
        subject: `[santi's list] ${immediateMatches.length} new listing${immediateMatches.length > 1 ? "s" : ""} for "${watch.name}"`,
        watchName: watch.name,
        listings: immediateMatches,
        pauseUrl: buildPauseUrl(watch.id) ?? undefined,
      });

      // Atomic — the email has genuinely gone out at this point, so marking
      // the notification SENT and the matches notified must succeed or fail
      // together. Previously these were two separate calls: if the second
      // one threw, the catch block below would overwrite the status to
      // FAILED even though the email was actually delivered. Also uses the
      // listing ids already in hand (newMatches) instead of re-joining
      // through listing.url, which only worked by coincidence of matching
      // immediateMatches 1:1 with newMatches in the same order.
      await prisma.$transaction([
        prisma.notification.update({
          where: { id: notification.id },
          data: { status: "SENT", sentAt: new Date() },
        }),
        prisma.watchMatch.updateMany({
          where: { watchId: watch.id, listingId: { in: newMatches.map((l) => l.id) } },
          data: { notified: true },
        }),
      ]);
      summary.immediateNotificationsSent += 1;
    } catch (err) {
      await prisma.notification.update({
        where: { id: notification.id },
        data: { status: "FAILED", errorMessage: err instanceof Error ? err.message : String(err) },
      });
      console.error(`Failed to send immediate notification for watch ${watch.id}:`, err);
    }
  }
}
