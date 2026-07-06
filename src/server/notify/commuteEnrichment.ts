import { getNearestStation, type NearestStation } from "@/server/geo/transitStations";
import { getCarCommutesBatch, getTransitCommute, type CommuteEstimate } from "@/server/geo/commute";
import { defaultCommuteModeForCity } from "@/lib/commuteMode";

type ListingForEnrichment = { city: string; latitude: number | null; longitude: number | null };
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
export async function getNotificationExtras(
  listing: ListingForEnrichment,
  work: WorkLocation | null,
): Promise<NotificationExtras> {
  if (listing.latitude == null || listing.longitude == null) return EMPTY_EXTRAS;

  const nearestStation = await getNearestStation(listing.city, listing.latitude, listing.longitude);
  if (!work) return { nearestStation, commute: null };

  const mode = defaultCommuteModeForCity(listing.city);
  const from = { latitude: listing.latitude, longitude: listing.longitude };

  const estimate =
    mode === "car" ? (await getCarCommutesBatch([from], work))[0] : await getTransitCommute(listing.city, from, work);

  return { nearestStation, commute: estimate ? { ...estimate, mode } : null };
}
