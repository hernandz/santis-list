import { haversineMiles } from "./haversine";

export type TransitLine = { name: string; color: string };

export type TransitStation = {
  name: string;
  lines: TransitLine[];
  latitude: number;
  longitude: number;
};

export type NearestStation = {
  name: string;
  lines: TransitLine[];
  distanceMiles: number;
  walkingMinutes: number;
};

const USER_AGENT = "Mozilla/5.0 (compatible; RentalWatchBot/0.1; personal-use apartment alert crawler)";
const STATIONS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Straight-line (haversine) distance undercounts real walking distance, since
// you walk along streets, not through buildings — a common rule of thumb is to
// inflate it ~1.3x for an urban grid. Average walking speed ~3 mph (Google
// Maps/Walk Score both use figures in this range).
const ROUTE_DETOUR_FACTOR = 1.3;
const WALKING_SPEED_MPH = 3;

function walkingMinutesFor(distanceMiles: number): number {
  return Math.round(((distanceMiles * ROUTE_DETOUR_FACTOR) / WALKING_SPEED_MPH) * 60);
}

function parseCsvLine(line: string): string[] {
  return line.split(",");
}

// Official, stable MTA subway bullet colors (unchanged since the 1970s
// Vignelli/Unimark signage standard) — public branding, not something to
// discover live.
const NYC_LINE_COLORS: Record<string, string> = {
  "1": "#EE352E",
  "2": "#EE352E",
  "3": "#EE352E",
  "4": "#00933C",
  "5": "#00933C",
  "6": "#00933C",
  "6X": "#00933C",
  "7": "#B933AD",
  "7X": "#B933AD",
  A: "#0039A6",
  C: "#0039A6",
  E: "#0039A6",
  B: "#FF6319",
  D: "#FF6319",
  F: "#FF6319",
  M: "#FF6319",
  G: "#6CBE45",
  J: "#996633",
  Z: "#996633",
  L: "#A7A9AC",
  N: "#FCCC0A",
  Q: "#FCCC0A",
  R: "#FCCC0A",
  W: "#FCCC0A",
  S: "#808183",
  SIR: "#0039A6",
};

function nycLine(name: string): TransitLine {
  return { name, color: NYC_LINE_COLORS[name] ?? "#666666" };
}

// Official MTA subway station reference data — one row per platform, grouped
// by "Complex ID" into a single physical station with its daytime routes.
async function fetchNycSubwayStations(): Promise<TransitStation[]> {
  const res = await fetch("http://web.mta.info/developers/data/nyct/subway/Stations.csv", {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`Failed to fetch MTA station data: ${res.status}`);

  const text = await res.text();
  const lines = text.trim().split("\n");
  const byComplex = new Map<string, { name: string; lineSet: Set<string>; latitude: number; longitude: number }>();

  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const complexId = cols[1];
    const stopName = cols[5];
    const routes = cols[7]?.split(" ").filter(Boolean) ?? [];
    const lat = Number(cols[9]);
    const lon = Number(cols[10]);
    if (!complexId || Number.isNaN(lat) || Number.isNaN(lon)) continue;

    const existing = byComplex.get(complexId);
    if (existing) {
      routes.forEach((r) => existing.lineSet.add(r));
    } else {
      byComplex.set(complexId, { name: stopName, lineSet: new Set(routes), latitude: lat, longitude: lon });
    }
  }

  return Array.from(byComplex.values()).map((s) => ({
    name: s.name,
    lines: Array.from(s.lineSet).sort().map(nycLine),
    latitude: s.latitude,
    longitude: s.longitude,
  }));
}

// BART's public API: station list + per-route ordered station lists (each
// with its own official hex color), joined to give each station the set of
// BART lines serving it.
async function fetchBartStations(): Promise<TransitStation[]> {
  const key = "MW9S-E7SL-26DU-VV8V"; // BART's own published public test key
  const stnRes = await fetch(`https://api.bart.gov/api/stn.aspx?cmd=stns&key=${key}&json=y`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!stnRes.ok) throw new Error(`Failed to fetch BART station list: ${stnRes.status}`);
  const stnBody = await stnRes.json();
  const stations: { name: string; abbr: string; gtfs_latitude: string; gtfs_longitude: string }[] =
    stnBody.root.stations.station;

  const routesRes = await fetch(`https://api.bart.gov/api/route.aspx?cmd=routes&key=${key}&json=y`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!routesRes.ok) throw new Error(`Failed to fetch BART routes: ${routesRes.status}`);
  const routesBody = await routesRes.json();
  const routeNumbers: string[] = routesBody.root.routes.route.map((r: { number: string }) => r.number);

  const linesByAbbr = new Map<string, Map<string, TransitLine>>();

  await Promise.all(
    routeNumbers.map(async (number) => {
      const res = await fetch(`https://api.bart.gov/api/route.aspx?cmd=routeinfo&route=${number}&key=${key}&json=y`, {
        headers: { "User-Agent": USER_AGENT },
      });
      if (!res.ok) return;
      const body = await res.json();
      const route = body.root.routes.route;
      const line: TransitLine = { name: route.color, color: route.hexcolor };
      const stationAbbrs: string[] = Array.isArray(route.config?.station)
        ? route.config.station
        : route.config?.station
          ? [route.config.station]
          : [];
      for (const abbr of stationAbbrs) {
        if (!linesByAbbr.has(abbr)) linesByAbbr.set(abbr, new Map());
        linesByAbbr.get(abbr)!.set(line.name, line);
      }
    }),
  );

  return stations.map((s) => ({
    name: s.name,
    lines: Array.from(linesByAbbr.get(s.abbr)?.values() ?? []).sort((a, b) => a.name.localeCompare(b.name)),
    latitude: Number(s.gtfs_latitude),
    longitude: Number(s.gtfs_longitude),
  }));
}

async function fetchGtfsText(path: string): Promise<string> {
  const res = await fetch(`https://gitlab.com/LACMTA/gtfs_rail/-/raw/master/${path}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`Failed to fetch LA Metro GTFS ${path}: ${res.status}`);
  return res.text();
}

// LA Metro's official GTFS rail feed. stops.txt alone only labels platforms with
// ride headsigns (e.g. terminal stations echo their own name), so line names
// (and each line's official hex color) are joined properly via
// routes.txt -> trips.txt -> stop_times.txt.
async function fetchLaMetroStations(): Promise<TransitStation[]> {
  const [stopsText, routesText, tripsText, stopTimesText] = await Promise.all([
    fetchGtfsText("stops.txt"),
    fetchGtfsText("routes.txt"),
    fetchGtfsText("trips.txt"),
    fetchGtfsText("stop_times.txt"),
  ]);

  // routes.txt: route_id,route_short_name,route_long_name,route_desc,route_type,route_color,route_text_color,route_url
  const routeById = new Map<string, TransitLine>();
  for (const cols of routesText.trim().split("\n").slice(1).map(parseCsvLine)) {
    routeById.set(cols[0], { name: cols[2], color: `#${cols[5]}` });
  }

  // trips.txt: route_id,service_id,trip_id,...
  const routeIdByTripId = new Map<string, string>();
  for (const cols of tripsText.trim().split("\n").slice(1).map(parseCsvLine)) {
    routeIdByTripId.set(cols[2], cols[0]);
  }

  // stop_times.txt: trip_id,arrival_time,departure_time,stop_id,...
  const linesByPlatformStopId = new Map<string, Map<string, TransitLine>>();
  for (const cols of stopTimesText.trim().split("\n").slice(1).map(parseCsvLine)) {
    const tripId = cols[0];
    const stopId = cols[3];
    const routeId = routeIdByTripId.get(tripId);
    const line = routeId ? routeById.get(routeId) : undefined;
    if (!line) continue;
    if (!linesByPlatformStopId.has(stopId)) linesByPlatformStopId.set(stopId, new Map());
    linesByPlatformStopId.get(stopId)!.set(line.name, line);
  }

  // stops.txt: stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,stop_url,location_type,parent_station,tpis_name
  const stopRows = stopsText.trim().split("\n").slice(1).map(parseCsvLine);

  const linesByParent = new Map<string, Map<string, TransitLine>>();
  for (const cols of stopRows) {
    const stopId = cols[0];
    const parentStation = cols[8];
    if (!parentStation) continue;
    const platformLines = linesByPlatformStopId.get(stopId);
    if (!platformLines) continue;
    if (!linesByParent.has(parentStation)) linesByParent.set(parentStation, new Map());
    for (const [name, line] of platformLines) linesByParent.get(parentStation)!.set(name, line);
  }

  const stations: TransitStation[] = [];
  for (const cols of stopRows) {
    const stopId = cols[0];
    const stopName = cols[2];
    const lat = Number(cols[4]);
    const lon = Number(cols[5]);
    const locationType = cols[7];
    if (locationType !== "1" || Number.isNaN(lat) || Number.isNaN(lon)) continue;

    stations.push({
      name: stopName,
      lines: Array.from(linesByParent.get(stopId)?.values() ?? []).sort((a, b) => a.name.localeCompare(b.name)),
      latitude: lat,
      longitude: lon,
    });
  }

  return stations;
}

const FETCHERS: Record<string, () => Promise<TransitStation[]>> = {
  newyork: fetchNycSubwayStations,
  sfbay: fetchBartStations,
  losangeles: fetchLaMetroStations,
};

const cache = new Map<string, { fetchedAt: number; stations: TransitStation[] }>();

export function clearTransitStationsCache(): void {
  cache.clear();
}

async function getStationsForCity(city: string): Promise<TransitStation[]> {
  const cached = cache.get(city);
  if (cached && Date.now() - cached.fetchedAt < STATIONS_TTL_MS) {
    return cached.stations;
  }

  const fetcher = FETCHERS[city];
  if (!fetcher) return [];

  try {
    const stations = await fetcher();
    cache.set(city, { fetchedAt: Date.now(), stations });
    return stations;
  } catch (err) {
    console.error(`Failed to fetch transit stations for ${city}:`, err);
    return cached?.stations ?? [];
  }
}

// Returns the `limit` closest stations, sorted nearest-first. Used both for
// "the" nearest station and for surfacing a second nearby option.
export async function getNearestStations(
  city: string,
  latitude: number,
  longitude: number,
  limit = 1,
): Promise<NearestStation[]> {
  const stations = await getStationsForCity(city);
  if (stations.length === 0) return [];

  return stations
    .map((station) => {
      const distanceMiles = haversineMiles(latitude, longitude, station.latitude, station.longitude);
      return {
        name: station.name,
        lines: station.lines,
        distanceMiles,
        walkingMinutes: walkingMinutesFor(distanceMiles),
      };
    })
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, limit);
}

export async function getNearestStation(
  city: string,
  latitude: number,
  longitude: number,
): Promise<NearestStation | null> {
  const [nearest] = await getNearestStations(city, latitude, longitude, 1);
  return nearest ?? null;
}

export async function getAllStations(city: string): Promise<TransitStation[]> {
  return getStationsForCity(city);
}

export async function getAllLines(city: string): Promise<TransitLine[]> {
  const stations = await getStationsForCity(city);
  const byName = new Map<string, TransitLine>();
  for (const station of stations) {
    for (const line of station.lines) byName.set(line.name, line);
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}
