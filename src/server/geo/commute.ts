import { haversineMiles } from "./haversine";
import { getNearestStation } from "./transitStations";

const USER_AGENT = "Mozilla/5.0 (compatible; RentalWatchBot/0.1; personal-use apartment alert crawler)";

export type CommuteEstimate = { minutes: number; distanceMiles: number; approximate: boolean };

type Point = { latitude: number; longitude: number };

// OSRM's free public demo routing server — real road-network driving routes,
// no API key. Not guaranteed for production volume, but fine for a personal,
// low-frequency tool. The table service computes one point (the work address)
// against many sources in a single request, instead of one request per listing.
export async function getCarCommutesBatch(from: Point[], to: Point): Promise<(CommuteEstimate | null)[]> {
  if (from.length === 0) return [];

  const coords = [...from.map((p) => `${p.longitude},${p.latitude}`), `${to.longitude},${to.latitude}`].join(";");
  const destinationIndex = from.length;
  const sources = from.map((_, i) => i).join(";");

  const url = `https://router.project-osrm.org/table/v1/driving/${coords}?sources=${sources}&destinations=${destinationIndex}&annotations=duration,distance`;

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

const AVERAGE_TRANSIT_SPEED_MPH = 17; // rough rapid-transit average including stops
const TRANSIT_WAIT_MINUTES = 6; // average wait for a train/bus plus destination egress

// There's no free, key-less multimodal transit routing API, so this is a
// straight-line estimate built from data already computed elsewhere: walk to
// the nearest station, ride at an assumed average transit speed, plus a
// fixed wait/egress allowance. Always approximate=true — shown as an
// estimate in the UI, not presented as routed directions like the car figure.
export async function getTransitCommute(city: string, from: Point, to: Point): Promise<CommuteEstimate | null> {
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
