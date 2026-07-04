import { craigslistSource } from "./sources/craigslist";

const LOCATIONS_TTL_MS = 15 * 60 * 1000;
const locationsCache = new Map<string, { fetchedAt: number; locations: string[] }>();

export function clearCraigslistLocationsCache(): void {
  locationsCache.clear();
}

/**
 * There's no public list of a city's sub-regions, so instead of a subarea
 * code we surface the real location strings already visible on that city's
 * current listings — live-derived suggestions for the region/neighborhood fields.
 */
export async function getCraigslistLocations(city: string): Promise<string[]> {
  const cached = locationsCache.get(city);
  if (cached && Date.now() - cached.fetchedAt < LOCATIONS_TTL_MS) {
    return cached.locations;
  }

  const listings = await craigslistSource.search({ city });
  const locations = Array.from(
    new Set(listings.map((l) => l.locationText?.trim()).filter((l): l is string => Boolean(l))),
  ).sort((a, b) => a.localeCompare(b));

  locationsCache.set(city, { fetchedAt: Date.now(), locations });
  return locations;
}
