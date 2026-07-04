import * as cheerio from "cheerio";
import { withRateLimit } from "@/server/rateLimiter";
import type { ListingDetails, ListingSource, RawListing, SearchCriteria } from "./types";

const USER_AGENT =
  "Mozilla/5.0 (compatible; RentalWatchBot/0.1; personal-use apartment alert crawler; contact: sntsmhz@gmail.com)";

const MAX_CONSECUTIVE_FAILURES = 3;
const CIRCUIT_COOLDOWN_MS = 15 * 60 * 1000;

// A listing that's expired/removed (404/410) is an expected content outcome,
// not a crawler health problem — it must not retry, and must not count
// toward the circuit breaker (otherwise one stale old listing during a
// backfill blocks every other request behind it).
export class ListingGoneError extends Error {
  constructor(url: string) {
    super(`Listing no longer exists: ${url}`);
    this.name = "ListingGoneError";
  }
}

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

export function resetCircuitBreaker(): void {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

function assertCircuitClosed() {
  if (Date.now() < circuitOpenUntil) {
    throw new Error(
      `Craigslist circuit breaker open until ${new Date(circuitOpenUntil).toISOString()} after repeated failures`,
    );
  }
}

function recordSuccess() {
  consecutiveFailures = 0;
}

function recordFailure() {
  consecutiveFailures += 1;
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
  }
}

async function politeFetch(url: string, attempt = 1): Promise<string> {
  assertCircuitClosed();

  try {
    const response = await withRateLimit(() =>
      fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow" }),
    );

    if (response.status === 404 || response.status === 410) {
      recordSuccess(); // the request itself succeeded — the content is just gone
      throw new ListingGoneError(url);
    }

    if (!response.ok) {
      throw new Error(`Craigslist request failed: ${response.status} ${response.statusText} for ${url}`);
    }

    const html = await response.text();
    recordSuccess();
    return html;
  } catch (err) {
    if (err instanceof ListingGoneError) throw err;

    recordFailure();
    if (attempt < 3) {
      const backoffMs = 2000 * attempt + Math.floor(Math.random() * 1000);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return politeFetch(url, attempt + 1);
    }
    throw err;
  }
}

function buildSearchUrl(criteria: SearchCriteria): string {
  // Verified live (2026-07-03): www.craigslist.org/search/subarea/{code}?cat=apa
  // returns a result set genuinely scoped to that sub-area (zero URL overlap
  // between e.g. sfc/eby), narrower than the metro-wide ~340-360 item
  // recency-capped window — a real crawl-scope win, not just cosmetic.
  const url = criteria.subarea
    ? new URL(`https://www.craigslist.org/search/subarea/${criteria.subarea}?cat=apa`)
    : new URL(`https://${criteria.city}.craigslist.org/search/apa`);

  if (criteria.minPrice != null) url.searchParams.set("min_price", String(criteria.minPrice));
  if (criteria.maxPrice != null) url.searchParams.set("max_price", String(criteria.maxPrice));

  return url.toString();
}

function extractExternalId(url: string): string | null {
  const match = url.match(/\/view\/d\/[^/]+\/([A-Za-z0-9]+)(?:\.html)?$/);
  return match ? match[1] : null;
}

async function search(criteria: SearchCriteria): Promise<RawListing[]> {
  const html = await politeFetch(buildSearchUrl(criteria));
  const $ = cheerio.load(html);

  const listings: RawListing[] = [];

  $("li.cl-static-search-result").each((_, el) => {
    const anchor = $(el).find("a").first();
    const url = anchor.attr("href");
    if (!url) return;

    const externalId = extractExternalId(url);
    if (!externalId) return;

    const title = anchor.find("div.title").first().text().trim() || $(el).attr("title") || "";
    const priceText = anchor.find("div.price").first().text().trim();
    const price = priceText ? Number(priceText.replace(/[^0-9]/g, "")) : null;
    const locationText = anchor.find("div.location").first().text().trim() || null;

    listings.push({
      externalId,
      url,
      title,
      price: price != null && !Number.isNaN(price) ? price : null,
      locationText,
      city: criteria.city,
    });
  });

  return listings;
}

function parseBedBath(attrText: string): { bedrooms: number | null; bathrooms: number | null } {
  // Matches patterns like "3BR / 2.5Ba", "1-2BR/1BA", "studio"
  const bedMatch = attrText.match(/(\d+)\s*BR/i);
  const bathMatch = attrText.match(/([\d.]+)\s*Ba/i);
  const isStudio = /studio/i.test(attrText);

  return {
    bedrooms: bedMatch ? Number(bedMatch[1]) : isStudio ? 0 : null,
    bathrooms: bathMatch ? Number(bathMatch[1]) : null,
  };
}

function parseFloatOrNull(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

async function fetchDetails(url: string): Promise<ListingDetails> {
  const html = await politeFetch(url);
  const $ = cheerio.load(html);

  const attrText = $("span.attr.important").first().text().trim();
  const { bedrooms, bathrooms } = parseBedBath(attrText);

  const postedDatetime = $("p.postinginfo time.date").first().attr("datetime");
  const postedAt = postedDatetime ? new Date(postedDatetime) : null;

  const mapEl = $("div#map.viewposting").first();
  const latitude = parseFloatOrNull(mapEl.attr("data-latitude"));
  const longitude = parseFloatOrNull(mapEl.attr("data-longitude"));
  const address = $("div.mapaddress").first().text().trim() || null;

  return { bedrooms, bathrooms, postedAt, address, latitude, longitude };
}

export const craigslistSource: ListingSource = { search, fetchDetails };
