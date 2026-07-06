import { haversineMiles } from "./haversine";
import { getNearestStation } from "./transitStations";

const USER_AGENT = "Mozilla/5.0 (compatible; RentalWatchBot/0.1; personal-use apartment alert crawler)";

export type CommuteEstimate = { minutes: number; distanceMiles: number; approximate: boolean };

type Point = { latitude: number; longitude: number };

// Free public OSRM routing servers, no API key — used only as a fallback
// when GOOGLE_MAPS_API_KEY isn't set (see getCarCommutesBatch/
// getBikeCommutesBatch below), since real-world spot-checks showed their
// estimates noticeably diverging from actual driving/biking times. The table
// service computes one point (the work address) against many sources in a
// single request, instead of one request per listing.
//
// Verified live 2026-07: router.project-osrm.org (the official demo) only
// actually hosts a driving-network graph — requesting its "/bike/" path
// silently returns identical results to "/driving/" rather than erroring, so
// it can't be used for real bike routing. routing.openstreetmap.de (a
// separate community-run demo) hosts genuinely distinct profile instances
// (routed-car, routed-bike) confirmed to give different routes/durations for
// the same two points.
async function getOsrmCommutesBatch(baseUrl: string, from: Point[], to: Point): Promise<(CommuteEstimate | null)[]> {
  if (from.length === 0) return [];

  const coords = [...from.map((p) => `${p.longitude},${p.latitude}`), `${to.longitude},${to.latitude}`].join(";");
  const destinationIndex = from.length;
  const sources = from.map((_, i) => i).join(";");

  const url = `${baseUrl}/table/v1/driving/${coords}?sources=${sources}&destinations=${destinationIndex}&annotations=duration,distance`;

  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) return from.map(() => null);
    const body = await res.json();
    const durations: (number | null)[] = body.durations?.map((row: (number | null)[]) => row[0]) ?? [];
    const distances: (number | null)[] = body.distances?.map((row: (number | null)[]) => row[0]) ?? [];

    return from.map((_, i) => {
      const duration = durations[i];
      const distanceMeters = distances[i];
      if (duration == null || distanceMeters == null) return null;
      return { minutes: Math.round(duration / 60), distanceMiles: distanceMeters / 1609.34, approximate: false };
    });
  } catch {
    return from.map(() => null);
  }
}

function hasGoogleMapsKey(): boolean {
  return Boolean(process.env.GOOGLE_MAPS_API_KEY);
}

// Real routing (actual roads/turns/one-ways, not a straight-line estimate)
// via the Directions API. Shared by driving, bicycling, and transit modes —
// same endpoint, just a different `mode` param. Used in preference to the
// free OSRM routers below whenever a key is configured, since OSRM's public
// demo servers turned out to be noticeably inaccurate in practice.
async function getGoogleDirectionsCommute(
  from: Point,
  to: Point,
  mode: "driving" | "bicycling" | "transit",
): Promise<CommuteEstimate | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;

  const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
  url.searchParams.set("origin", `${from.latitude},${from.longitude}`);
  url.searchParams.set("destination", `${to.latitude},${to.longitude}`);
  url.searchParams.set("mode", mode);
  url.searchParams.set("key", key);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const body = await res.json();
    if (body.status !== "OK") return null;

    const leg = body.routes?.[0]?.legs?.[0];
    if (!leg?.duration?.value || !leg?.distance?.value) return null;

    return {
      minutes: Math.round(leg.duration.value / 60),
      distanceMiles: leg.distance.value / 1609.34,
      approximate: false,
    };
  } catch {
    return null;
  }
}

// Each point is looked up independently (Directions has no multi-origin
// batch endpoint the way OSRM's table service does), but the caller-side
// caps (COMMUTE_EXTERNAL_API_CAP in api/listings/route.ts) already treat
// car/bike as real per-request external calls regardless of provider, so
// this doesn't change how many requests a given page/map load can trigger.
export function getCarCommutesBatch(from: Point[], to: Point): Promise<(CommuteEstimate | null)[]> {
  if (hasGoogleMapsKey()) {
    return Promise.all(from.map((p) => getGoogleDirectionsCommute(p, to, "driving")));
  }
  return getOsrmCommutesBatch("https://router.project-osrm.org", from, to);
}

export function getBikeCommutesBatch(from: Point[], to: Point): Promise<(CommuteEstimate | null)[]> {
  if (hasGoogleMapsKey()) {
    return Promise.all(from.map((p) => getGoogleDirectionsCommute(p, to, "bicycling")));
  }
  return getOsrmCommutesBatch("https://routing.openstreetmap.de/routed-bike", from, to);
}

const AVERAGE_TRANSIT_SPEED_MPH = 17; // rough rapid-transit average including stops
const TRANSIT_WAIT_MINUTES = 6; // average wait for a train/bus plus destination egress

// Straight-line estimate built from data already computed elsewhere: walk to
// the nearest station, ride at an assumed average transit speed, plus a
// fixed wait/egress allowance. Always approximate=true. Used as a free
// fallback when there's no Google Maps key configured, or if a real lookup
// fails for some reason (e.g. no transit route exists between the two points).
async function getHeuristicTransitCommute(city: string, from: Point, to: Point): Promise<CommuteEstimate | null> {
  const nearest = await getNearestStation(city, from.latitude, from.longitude);
  if (!nearest) return null;

  const rideDistanceMiles = haversineMiles(from.latitude, from.longitude, to.latitude, to.longitude);
  const rideMinutes = (rideDistanceMiles / AVERAGE_TRANSIT_SPEED_MPH) * 60;

  return {
    minutes: Math.round(nearest.walkingMinutes + TRANSIT_WAIT_MINUTES + rideMinutes),
    distanceMiles: rideDistanceMiles,
    approximate: true,
  };
}

export function usesGoogleTransit(): boolean {
  return hasGoogleMapsKey();
}

// Real transit routing (actual schedules/transfers) via the Directions API.
// Google's free tier is 10,000 requests/month — fine for a personal tool's
// actual browsing volume, but callers should still avoid firing this for
// large candidate pools (see usesGoogleTransit + the caps in
// api/listings/route.ts) since it's a real per-request cost past that.
export async function getTransitCommute(city: string, from: Point, to: Point): Promise<CommuteEstimate | null> {
  const google = await getGoogleDirectionsCommute(from, to, "transit");
  if (google) return google;
  return getHeuristicTransitCommute(city, from, to);
}
