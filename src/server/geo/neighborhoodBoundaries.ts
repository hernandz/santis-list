import fs from "node:fs";
import path from "node:path";
import { pointInGeometry, type GeoJsonGeometry } from "./pointInPolygon";
import { readDiskCache, readDiskCacheStale, writeDiskCache, clearDiskCache } from "@/server/diskCache";

// region is a coarser grouping the boundary dataset happens to carry (NYC's
// NTA dataset includes a borough per neighborhood) — used only to pare down
// the neighborhood picker once a Craigslist sub-area is selected, since a
// sub-area's display label (e.g. "Brooklyn") matches the region name exactly.
// null where the source dataset has no such grouping (SF, LA).
type Boundary = { name: string; geometry: GeoJsonGeometry; region: string | null };

const USER_AGENT = "Mozilla/5.0 (compatible; RentalWatchBot/0.1; personal-use apartment alert crawler)";
const BOUNDARIES_TTL_MS = 30 * 24 * 60 * 60 * 1000; // official boundaries essentially never change

type GeoJsonFeatureCollection = {
  features: { properties: Record<string, unknown>; geometry: Boundary["geometry"] }[];
};

// Bundled under public/ (not src/) specifically because the Dockerfile's
// production stage only copies node_modules/.next/public/prisma — src/ never
// makes it into the deployed image, so fs.readFileSync against a src/ path
// would 404/ENOENT in production despite working fine in local dev. public/
// is a hard Next.js requirement in every deploy mode, so it's guaranteed to
// exist regardless of how the image gets built (Dockerfile here, or
// Railway's own Nixpacks). These files being technically web-reachable at
// /geo-data/... is a non-issue — it's the exact same public government
// open-data anyone could already pull from the source APIs directly.
function readLocalGeoJson(filename: string): GeoJsonFeatureCollection {
  const raw = fs.readFileSync(path.join(process.cwd(), "public", "geo-data", filename), "utf-8");
  return JSON.parse(raw);
}

// NYC's and LA's boundaries are stored locally (see readLocalGeoJson) rather
// than live-fetched like every other city here — verified live 2026-07-07
// that data.cityofnewyork.us returns a flat 403 from Railway's production
// network (not a rate limit; an outright block), and with no disk cache yet
// on a fresh deploy there's nothing to fall back to, so NYC boundaries were
// completely unavailable in production. Real city/borough boundaries don't
// change on any timescale that matters here, so — same reasoning as the
// Muni/Caltrain/VTA station data — hardcoding beats depending on a live
// source that may simply not be reachable at runtime. Downloaded 2026-07-07.
async function fetchNycNeighborhoods(): Promise<Boundary[]> {
  const body = readLocalGeoJson("nyc-neighborhoods.geojson.json");
  return body.features.map((f) => ({
    name: String(f.properties.ntaname),
    geometry: f.geometry,
    region: String(f.properties.boroname),
  }));
}

// SF's DataSF portal serves several "Analysis Neighborhoods" resource IDs; p5b7-5n3h
// (the top search hit) returns empty geometry — j2bu-swwd is the one with real polygons.
// region is tagged "San Francisco" (matching the "sfc" sub-area's label) so that
// selecting the East Bay sub-area below doesn't surface SF neighborhoods as options.
async function fetchSfNeighborhoods(): Promise<Boundary[]> {
  const res = await fetch("https://data.sfgov.org/resource/j2bu-swwd.geojson?$limit=5000", {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`Failed to fetch SF neighborhood boundaries: ${res.status}`);
  const body: GeoJsonFeatureCollection = await res.json();
  return body.features.map((f) => ({
    name: String(f.properties.nhood),
    geometry: f.geometry,
    region: "San Francisco",
  }));
}

// Oakland's own open-data portal serves several "neighborhoods" resource IDs;
// 7zky-kcq9 and 42ta-nj45 (both top search hits) return empty geometry —
// sb4q-6bkc is the one with real polygons (verified live 2026-07-06: 131
// features, none null). Finer-grained than the city-level fallback below,
// same relationship as fetchLaCityNeighborhoods has to fetchLaCountyNeighborhoods.
async function fetchOaklandNeighborhoods(): Promise<Boundary[]> {
  const res = await fetch("https://data.oaklandca.gov/resource/sb4q-6bkc.geojson?$limit=500", {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`Failed to fetch Oakland neighborhood boundaries: ${res.status}`);
  const body: GeoJsonFeatureCollection = await res.json();
  return body.features.map((f) => ({
    name: String(f.properties.neighbhd),
    geometry: f.geometry,
    region: "East Bay",
  }));
}

// Whole-city fallback shared by every Bay Area sub-area that doesn't have its
// own neighborhood-level dataset (everywhere in the East Bay besides Oakland,
// and all of the Peninsula/South Bay besides San Jose) — same role as
// fetchLaCountyNeighborhoods plays for LA County cities outside LA proper.
// Source: CDTFA's statewide city-boundaries layer (the same authoritative
// source California itself uses for tax-rate jurisdiction, and already
// reachable/no-auth like every other boundary source here). excludeCities
// drops cities already covered by a finer per-neighborhood layer elsewhere.
// Some cities (e.g. Alameda's Bay Farm Island) are disjoint and come back as
// two separate rows sharing a name — left as-is; that's a truthful shape, not
// a bug (same pattern as MultiPolygon geometries elsewhere in this file).
async function fetchCdtfaCityBoundaries(
  counties: string[],
  region: string,
  excludeCities: string[] = [],
): Promise<Boundary[]> {
  const where = `CDTFA_COUNTY IN (${counties.map((c) => `'${c}'`).join(",")})`;
  const url =
    "https://services3.arcgis.com/uknczv4rpevve42E/arcgis/rest/services/" +
    "California_Cities_and_Identifiers_Blue_Version_view/FeatureServer/2/query" +
    `?where=${encodeURIComponent(where)}&outFields=CDTFA_CITY&outSR=4326&f=geojson&resultRecordCount=1000`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Failed to fetch ${region} city boundaries: ${res.status}`);
  const body: GeoJsonFeatureCollection = await res.json();
  return body.features
    .filter((f) => !excludeCities.includes(String(f.properties.CDTFA_CITY ?? "").trim()))
    .map((f) => ({ name: String(f.properties.CDTFA_CITY), geometry: f.geometry, region }));
}

// San Jose's own open-data portal publishes a few different neighborhood-ish
// layers, none of them right on their own: "neighborhoods" is 297 raw
// census-block-group clusters with names like "Aborn and Silver Creek", the
// "Neighborhood and Business Associations" layer is just as granular in a
// different way (mostly HOA/mobile-home/tract-association turf like "Baker
// West NA"), and "Planning Areas" (15 districts) is real but too coarse to
// capture well-known places like Japantown or Rose Garden, which just sit
// inside its catch-all "Central" district. Real per-neighborhood polygons
// for those (verified live 2026-07-06 via Overpass) only exist in
// OpenStreetMap as center points, not surveyed boundaries.
//
// Zillow's neighborhood boundaries — real, hand-drawn, industry-standard
// shapes long used across real estate — solve this properly: San Jose has 17
// of them (Willow Glen, Rose Garden, Downtown, Almaden Valley, Berryessa,
// Alviso, Evergreen, Cambrian Park, etc.), still mirrored by the US EPA on a
// stable, no-auth ArcGIS endpoint after Zillow stopped hosting its own
// download page. Verified live 2026-07-06: 17 features, none null, real
// irregular shapes (e.g. "Rose Garden" has 564 vertices — nothing like a
// circle).
async function fetchSanJoseNeighborhoods(): Promise<Boundary[]> {
  const url =
    "https://gispub.epa.gov/arcgis/rest/services/OEI/Zillow_Neighborhoods/MapServer/1/query" +
    "?where=City%3D%27San+Jose%27+AND+State%3D%27CA%27&outFields=Name&outSR=4326&f=geojson&resultRecordCount=1000";
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Failed to fetch San Jose neighborhood boundaries: ${res.status}`);
  const body: GeoJsonFeatureCollection = await res.json();
  return body.features.map((f) => ({ name: String(f.properties.Name), geometry: f.geometry, region: "South Bay" }));
}

// Merges SF proper, Oakland's and San Jose's fine-grained neighborhoods, and
// the rest of the East Bay/Peninsula/South Bay's whole-city fallback — same
// non-overlapping-extension approach as fetchLaNeighborhoods.
async function fetchBayAreaNeighborhoods(): Promise<Boundary[]> {
  const [sf, oakland, sanJose, restOfEastBay, restOfPeninsula, restOfSouthBay] = await Promise.all([
    fetchSfNeighborhoods(),
    fetchOaklandNeighborhoods(),
    fetchSanJoseNeighborhoods(),
    fetchCdtfaCityBoundaries(["Alameda County", "Contra Costa County"], "East Bay", ["Oakland"]),
    fetchCdtfaCityBoundaries(["San Mateo County"], "Peninsula"),
    fetchCdtfaCityBoundaries(["Santa Clara County"], "South Bay", ["San Jose"]),
  ]);
  return [...sf, ...oakland, ...sanJose, ...restOfEastBay, ...restOfPeninsula, ...restOfSouthBay];
}

// LA City's own neighborhood layer (finer-grained within LA proper — e.g. it
// has "Sawtelle" as its own polygon, which the countywide layer below folds
// into the larger "West Los Angeles"). Stored locally like NYC above — same
// reasoning (these boundaries don't change on any relevant timescale, and a
// live source shouldn't be a single point of failure for something this
// static). Downloaded 2026-07-07.
async function fetchLaCityNeighborhoods(): Promise<Boundary[]> {
  const body = readLocalGeoJson("la-city-neighborhoods.geojson.json");
  return body.features.map((f) => ({ name: String(f.properties.name), geometry: f.geometry, region: null }));
}

// LA County's official "Cities and Communities (Statistical Areas)" layer —
// covers the whole county, so unlike the LA-city-only layer above, it
// includes every independent city Craigslist's LA metro spans (Santa Monica,
// Beverly Hills, Culver City, Long Beach, Pasadena, etc.) plus unincorporated
// communities. 373 features, outSR=4326 gives plain lat/lon (the service's
// default CRS is a feet-based state-plane projection). Stored locally —
// downloaded 2026-07-07, same reasoning as fetchLaCityNeighborhoods above.
async function fetchLaCountyNeighborhoods(): Promise<Boundary[]> {
  const body = readLocalGeoJson("la-county-neighborhoods.geojson.json");
  return body.features
    .filter((f) => String(f.properties.LCITY ?? "").trim() !== "Los Angeles") // covered by the finer-grained layer above
    .map((f) => {
      // A blank COMMUNITY means this row is a whole city with no further
      // breakdown (e.g. plain "Santa Monica") — fall back to the city name.
      const community = String(f.properties.COMMUNITY ?? "").trim();
      const city = String(f.properties.LCITY ?? "").trim();
      return { name: community || city, geometry: f.geometry, region: null };
    });
}

// Merges LA city's finer internal neighborhoods with the rest of the county's
// cities/communities — the two datasets don't geometrically overlap (the
// county layer's rows are filtered to exclude LA proper), so combining them
// just extends coverage outward, e.g. to add "Santa Monica" without losing
// "Sawtelle".
async function fetchLaNeighborhoods(): Promise<Boundary[]> {
  const [cityNeighborhoods, countyNeighborhoods] = await Promise.all([
    fetchLaCityNeighborhoods(),
    fetchLaCountyNeighborhoods(),
  ]);
  return [...cityNeighborhoods, ...countyNeighborhoods];
}

const FETCHERS: Record<string, () => Promise<Boundary[]>> = {
  newyork: fetchNycNeighborhoods,
  sfbay: fetchBayAreaNeighborhoods,
  losangeles: fetchLaNeighborhoods,
};

const cache = new Map<string, { fetchedAt: number; boundaries: Boundary[] }>();

function diskCacheKey(city: string): string {
  return `neighborhood-boundaries-${city}`;
}

export function clearNeighborhoodBoundariesCache(): void {
  cache.clear();
  for (const city of Object.keys(FETCHERS)) clearDiskCache(diskCacheKey(city));
}

// Dedupes concurrent cache-miss callers for the same city — see the
// identical pattern (and rationale) in transitStations.ts's
// getStationsForCity: without it, a cold cache means every listing in a
// single request fires its own real fetch instead of sharing one.
const pendingFetches = new Map<string, Promise<Boundary[]>>();

async function getBoundariesForCity(city: string): Promise<Boundary[]> {
  const cached = cache.get(city);
  if (cached && Date.now() - cached.fetchedAt < BOUNDARIES_TTL_MS) {
    return cached.boundaries;
  }

  // Disk cache survives dev server restarts — in-memory alone means every
  // restart re-fetches live, which is how these free public APIs' rate
  // limits get tripped during a long dev session.
  const onDisk = readDiskCache<Boundary[]>(diskCacheKey(city), BOUNDARIES_TTL_MS);
  if (onDisk) {
    cache.set(city, { fetchedAt: Date.now(), boundaries: onDisk });
    return onDisk;
  }

  const pending = pendingFetches.get(city);
  if (pending) return pending;

  const fetcher = FETCHERS[city];
  if (!fetcher) return [];

  const promise = (async () => {
    try {
      const boundaries = await fetcher();
      cache.set(city, { fetchedAt: Date.now(), boundaries });
      writeDiskCache(diskCacheKey(city), boundaries);
      return boundaries;
    } catch (err) {
      console.error(`Failed to fetch neighborhood boundaries for ${city}:`, err);
      return cached?.boundaries ?? readDiskCacheStale<Boundary[]>(diskCacheKey(city)) ?? [];
    } finally {
      pendingFetches.delete(city);
    }
  })();

  pendingFetches.set(city, promise);
  return promise;
}

// regions, when given, pares the list down to neighborhoods in one of those
// regions (matched case-insensitively against the boundary dataset's region
// field, e.g. NYC's borough) — a no-op if the dataset has no region grouping
// (SF, LA) or none of the given regions match anything.
export async function getNeighborhoodNames(city: string, regions?: string[]): Promise<string[]> {
  const boundaries = await getBoundariesForCity(city);
  const wanted = regions?.map((r) => r.toLowerCase());
  const filtered =
    wanted && wanted.length > 0 && boundaries.some((b) => b.region != null)
      ? boundaries.filter((b) => b.region != null && wanted.includes(b.region.toLowerCase()))
      : boundaries;
  return Array.from(new Set(filtered.map((b) => b.name))).sort((a, b) => a.localeCompare(b));
}

export async function getNeighborhoodBoundaries(
  city: string,
): Promise<{ name: string; geometry: GeoJsonGeometry; region: string | null }[]> {
  const boundaries = await getBoundariesForCity(city);
  return boundaries.map((b) => ({ name: b.name, geometry: b.geometry, region: b.region }));
}

export async function getNeighborhoodForPoint(
  city: string,
  latitude: number,
  longitude: number,
): Promise<string | null> {
  const boundaries = await getBoundariesForCity(city);
  for (const boundary of boundaries) {
    if (pointInGeometry(longitude, latitude, boundary.geometry)) {
      return boundary.name;
    }
  }
  return null;
}
