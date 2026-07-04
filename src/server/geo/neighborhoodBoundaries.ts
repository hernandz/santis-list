import { pointInGeometry, type GeoJsonGeometry } from "./pointInPolygon";

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

async function fetchNycNeighborhoods(): Promise<Boundary[]> {
  const res = await fetch("https://data.cityofnewyork.us/resource/9nt8-h7nd.geojson?$limit=5000", {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`Failed to fetch NYC neighborhood boundaries: ${res.status}`);
  const body: GeoJsonFeatureCollection = await res.json();
  return body.features.map((f) => ({
    name: String(f.properties.ntaname),
    geometry: f.geometry,
    region: String(f.properties.boroname),
  }));
}

// SF's DataSF portal serves several "Analysis Neighborhoods" resource IDs; p5b7-5n3h
// (the top search hit) returns empty geometry — j2bu-swwd is the one with real polygons.
async function fetchSfNeighborhoods(): Promise<Boundary[]> {
  const res = await fetch("https://data.sfgov.org/resource/j2bu-swwd.geojson?$limit=5000", {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`Failed to fetch SF neighborhood boundaries: ${res.status}`);
  const body: GeoJsonFeatureCollection = await res.json();
  return body.features.map((f) => ({ name: String(f.properties.nhood), geometry: f.geometry, region: null }));
}

async function fetchLaNeighborhoods(): Promise<Boundary[]> {
  const res = await fetch("https://geohub.lacity.org/datasets/d6c55385a0e749519f238b77135eafac_0.geojson", {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`Failed to fetch LA neighborhood boundaries: ${res.status}`);
  const body: GeoJsonFeatureCollection = await res.json();
  return body.features.map((f) => ({ name: String(f.properties.name), geometry: f.geometry, region: null }));
}

const FETCHERS: Record<string, () => Promise<Boundary[]>> = {
  newyork: fetchNycNeighborhoods,
  sfbay: fetchSfNeighborhoods,
  losangeles: fetchLaNeighborhoods,
};

const cache = new Map<string, { fetchedAt: number; boundaries: Boundary[] }>();

export function clearNeighborhoodBoundariesCache(): void {
  cache.clear();
}

async function getBoundariesForCity(city: string): Promise<Boundary[]> {
  const cached = cache.get(city);
  if (cached && Date.now() - cached.fetchedAt < BOUNDARIES_TTL_MS) {
    return cached.boundaries;
  }

  const fetcher = FETCHERS[city];
  if (!fetcher) return [];

  try {
    const boundaries = await fetcher();
    cache.set(city, { fetchedAt: Date.now(), boundaries });
    return boundaries;
  } catch (err) {
    console.error(`Failed to fetch neighborhood boundaries for ${city}:`, err);
    return cached?.boundaries ?? [];
  }
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
