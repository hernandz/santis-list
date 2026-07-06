import { getNearestStation, type NearestStation } from "@/server/geo/transitStations";
import { getCarCommutesBatch, getTransitCommute, type CommuteEstimate } from "@/server/geo/commute";
import { getCachedCommutes, saveCommutes } from "@/server/geo/commuteCache";
import { defaultCommuteModeForCity } from "@/lib/commuteMode";

type ListingForEnrichment = { id: string; city: string; latitude: number | null; longitude: number | null };
export type WorkLocation = { latitude: number; longitude: number };

export type NotificationExtras = {
  nearestStation: NearestStation | null;
  commute: (CommuteEstimate & { mode: "car" | "transit" }) | null;
};

const EMPTY_EXTRAS: NotificationExtras = { nearestStation: null, commute: null };

// Same info the listings feed/map already show — distance to the nearest
// station, and a commute estimate using each city's default mode (car for
// LA, transit elsewhere, matching defaultCommuteModeForCity) — added to
// notification emails too, not just the browsable views. `work` is looked
// up once per crawl cycle/digest flush by the caller, not per listing.
// Backed by the same CommuteCache the browse/map feed uses (see
// commuteCache.ts) — a notification fires once per listing per watch, but
// the same listing is often also viewed on the feed/map, so sharing the
// cache avoids a second real lookup for something already computed. useGoogle
// gates whether a real (paid past free tier) Google Directions call is even
// allowed — see Settings.useGoogleDirections; false means the free OSRM/
// heuristic fallback is used instead, same as everywhere else in the app.
export async function getNotificationExtras(
  listing: ListingForEnrichment,
  work: WorkLocation | null,
  useGoogle: boolean,
): Promise<NotificationExtras> {
  if (listing.latitude == null || listing.longitude == null) return EMPTY_EXTRAS;

  const nearestStation = await getNearestStation(listing.city, listing.latitude, listing.longitude);
  if (!work) return { nearestStation, commute: null };

  const mode = defaultCommuteModeForCity(listing.city);
  const from = { latitude: listing.latitude, longitude: listing.longitude };

  const cached = await getCachedCommutes([listing.id], mode, work);
  let estimate = cached.get(listing.id) ?? null;
  if (!estimate) {
    estimate =
      mode === "car"
        ? (await getCarCommutesBatch([from], work, useGoogle))[0]
        : await getTransitCommute(listing.city, from, work, useGoogle);
    if (estimate && !estimate.approximate) {
      await saveCommutes([{ listingId: listing.id, mode, estimate }], work);
    }
  }

  return { nearestStation, commute: estimate ? { ...estimate, mode } : null };
}
