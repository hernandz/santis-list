const USER_AGENT =
  "Mozilla/5.0 (compatible; RentalWatchBot/0.1; personal-use apartment alert crawler; contact: sntsmhz@gmail.com)";

export type GeocodeResult = { latitude: number; longitude: number; displayName: string };

// OpenStreetMap's free Nominatim geocoder — usage policy caps this at 1
// request/sec and requires a descriptive User-Agent identifying the app,
// both satisfied here. Fine for a personal tool geocoding one address at a
// time on save (or a few autocomplete lookups), not for bulk/high-volume use.
export async function searchAddresses(query: string, limit = 5): Promise<GeocodeResult[]> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url.toString(), { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Geocoding request failed: ${res.status}`);

  const results: { lat: string; lon: string; display_name: string }[] = await res.json();
  return results.map((r) => ({ latitude: Number(r.lat), longitude: Number(r.lon), displayName: r.display_name }));
}

export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  const [first] = await searchAddresses(address, 1);
  return first ?? null;
}
