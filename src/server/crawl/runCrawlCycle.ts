import { prisma } from "@/server/db/prisma";
import type { Listing, Watch } from "@/generated/prisma/client";
import { emailChannel } from "@/server/notify/email";
import type { NotificationListingPayload } from "@/server/notify/types";
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

// Verifies a listing's real coordinates actually fall inside one of the watch's
// selected neighborhood polygons, rather than trusting Craigslist's own text
// search alone. If the listing has no map coordinates (Craigslist doesn't always
// include one), we fall back to trusting the text-search match rather than
// silently dropping otherwise-real matches for lack of geo data.
async function passesNeighborhoodBoundary(watch: Watch, listing: Listing): Promise<boolean> {
  if (watch.neighborhoods.length === 0) return true;
  if (listing.latitude == null || listing.longitude == null) return true;

  const actualNeighborhood = await getNeighborhoodForPoint(listing.city, listing.latitude, listing.longitude);
  return actualNeighborhood != null && watch.neighborhoods.includes(actualNeighborhood);
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

  const promise = source.search(criteria);
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

export function isCrawlInProgress(): boolean {
  return inProgress;
}

export function getLastCrawlResult() {
  return lastResult;
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
  }
}

async function runCrawlCycleUnguarded(): Promise<CrawlCycleSummary> {
  const watches = await prisma.watch.findMany({ where: { isActive: true } });
  const searchCache: SearchCache = new Map();

  const summary: CrawlCycleSummary = {
    watchesProcessed: 0,
    watchesFailed: 0,
    listingsSeen: 0,
    newListings: 0,
    matchesCreated: 0,
    immediateNotificationsSent: 0,
  };

  for (const watch of watches) {
    // One watch's failure (bad city, transient network error, CL rate limiting, ...)
    // must not stop the rest of the active watches from being crawled.
    try {
      await processWatch(watch, summary, searchCache);
      summary.watchesProcessed += 1;
    } catch (err) {
      summary.watchesFailed += 1;
      console.error(`Crawl failed for watch "${watch.name}" (${watch.id}):`, err);
    }
  }

  return summary;
}

async function processWatch(watch: Watch, summary: CrawlCycleSummary, searchCache: SearchCache): Promise<void> {
  const source = sources.CRAIGSLIST;
  // Search by subarea (if set) or the whole city, then rely on
  // passesNeighborhoodBoundary (real polygon geometry) to attribute listings
  // to neighborhoods, rather than Craigslist's own query= text search — that
  // breaks for official boundary names real posters never write, e.g.
  // "Bushwick (East)"/"(West)".
  const rawListings = await searchAllSubareas(source, watch, searchCache);

  const immediateMatches: NotificationListingPayload[] = [];

  for (const raw of rawListings) {
    summary.listingsSeen += 1;

    let listing = await prisma.listing.findUnique({
      where: { source_externalId: { source: "CRAIGSLIST", externalId: raw.externalId } },
    });

    if (!listing) {
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

      try {
        const details = await source.fetchDetails(raw.url);
        listing = await prisma.listing.update({
          where: { id: listing.id },
          data: {
            bedrooms: details.bedrooms,
            bathrooms: details.bathrooms,
            postedAt: details.postedAt,
            address: details.address,
            latitude: details.latitude,
            longitude: details.longitude,
          },
        });
      } catch (err) {
        console.error(`Failed to fetch details for ${raw.url}:`, err);
      }
    }

    if (!passesThresholds(watch, listing)) continue;
    if (!(await passesNeighborhoodBoundary(watch, listing))) continue;

    const existingMatch = await prisma.watchMatch.findUnique({
      where: { watchId_listingId: { watchId: watch.id, listingId: listing.id } },
    });
    if (existingMatch) continue;

    await prisma.watchMatch.create({ data: { watchId: watch.id, listingId: listing.id } });
    summary.matchesCreated += 1;

    if (watch.notifyFrequency === "IMMEDIATE") {
      immediateMatches.push({
        title: listing.title,
        url: listing.url,
        price: listing.price,
        bedrooms: listing.bedrooms,
        bathrooms: listing.bathrooms,
        locationText: listing.locationText,
      });
    }
  }

  const alertEmail =
    (await prisma.settings.findUnique({ where: { id: "singleton" } }))?.alertEmail || process.env.NOTIFY_TO_EMAIL;

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

      await prisma.notification.update({
        where: { id: notification.id },
        data: { status: "SENT", sentAt: new Date() },
      });
      await prisma.watchMatch.updateMany({
        where: { watchId: watch.id, listing: { url: { in: immediateMatches.map((m) => m.url) } } },
        data: { notified: true },
      });
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
