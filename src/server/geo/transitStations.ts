import { haversineMiles } from "./haversine";
import { readDiskCache, readDiskCacheStale, writeDiskCache, clearDiskCache } from "@/server/diskCache";

// system is only populated where a city actually mixes multiple independent
// transit operators (e.g. sfbay: BART/Muni Metro/Caltrain/VTA) — it's what
// lets the UI group the line picker by operator there. Left undefined for
// single-operator cities (NYC subway, LA Metro), where grouping would just
// add a redundant single header.
export type TransitLine = { name: string; color: string; system?: string };

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

// Muni Metro (SF light rail), Caltrain, and VTA light rail don't have
// live-fetchable, no-auth-required static feeds the way BART/NYC/LA do —
// SFMTA's own GTFS host (gtfs.sfmta.com) refused every connection attempt
// during development (not just rate limiting — outright connection
// refused), and 511.org's regional feed requires a registration-gated
// API key. These three systems' stations also basically never change
// (new lines/stations are rare, multi-year civic projects), unlike bus
// routes, so hardcoding real station data (compiled 2026-07 from each
// system's own real GTFS/GIS data — VTA's own gtfs.vta.org, the official
// California rail stations open-data layer for Caltrain, and OpenStreetMap
// for Muni Metro, which had already done the real-vs-tram_stop
// classification work) is the pragmatic choice here instead of chasing a
// live source that may not even be reachable at runtime.
const MUNI_METRO_STATIONS: TransitStation[] = [
  { name: "2nd & King", lines: [{ name: "N", color: "#0039A6", system: "Muni Metro" }, { name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7793466, longitude: -122.3902045 },
  { name: "Brannan", lines: [{ name: "N", color: "#0039A6", system: "Muni Metro" }, { name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7837573, longitude: -122.388127 },
  { name: "Folsom", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7904517, longitude: -122.3895673 },
  { name: "Caltrain", lines: [{ name: "N", color: "#0039A6", system: "Muni Metro" }], latitude: 37.7759911, longitude: -122.394497 },
  { name: "4th & King", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.776019, longitude: -122.393636 },
  { name: "Stonestown", lines: [{ name: "M", color: "#00A651", system: "Muni Metro" }], latitude: 37.7274507, longitude: -122.4749029 },
  { name: "S.F. State", lines: [{ name: "M", color: "#00A651", system: "Muni Metro" }], latitude: 37.7216578, longitude: -122.4752089 },
  { name: "Mission Rock", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7729321, longitude: -122.3896918 },
  { name: "23rd Street", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7553756, longitude: -122.3880198 },
  { name: "UCSF/Chase Center", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7681918, longitude: -122.3892458 },
  { name: "Montgomery Street", lines: [{ name: "J", color: "#522398", system: "Muni Metro" }, { name: "K", color: "#0072BC", system: "Muni Metro" }, { name: "L", color: "#FFC72C", system: "Muni Metro" }, { name: "M", color: "#00A651", system: "Muni Metro" }, { name: "N", color: "#0039A6", system: "Muni Metro" }, { name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7892283, longitude: -122.401472 },
  { name: "Embarcadero", lines: [{ name: "J", color: "#522398", system: "Muni Metro" }, { name: "K", color: "#0072BC", system: "Muni Metro" }, { name: "L", color: "#FFC72C", system: "Muni Metro" }, { name: "M", color: "#00A651", system: "Muni Metro" }, { name: "N", color: "#0039A6", system: "Muni Metro" }, { name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7928637, longitude: -122.396912 },
  { name: "Castro", lines: [{ name: "J", color: "#522398", system: "Muni Metro" }, { name: "K", color: "#0072BC", system: "Muni Metro" }, { name: "L", color: "#FFC72C", system: "Muni Metro" }, { name: "M", color: "#00A651", system: "Muni Metro" }, { name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7626004, longitude: -122.4352931 },
  { name: "Church", lines: [{ name: "J", color: "#522398", system: "Muni Metro" }, { name: "K", color: "#0072BC", system: "Muni Metro" }, { name: "L", color: "#FFC72C", system: "Muni Metro" }, { name: "M", color: "#00A651", system: "Muni Metro" }, { name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7672666, longitude: -122.4292613 },
  { name: "Civic Center", lines: [{ name: "J", color: "#522398", system: "Muni Metro" }, { name: "K", color: "#0072BC", system: "Muni Metro" }, { name: "L", color: "#FFC72C", system: "Muni Metro" }, { name: "M", color: "#00A651", system: "Muni Metro" }, { name: "N", color: "#0039A6", system: "Muni Metro" }, { name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7793625, longitude: -122.4139719 },
  { name: "Powell Street", lines: [{ name: "J", color: "#522398", system: "Muni Metro" }, { name: "K", color: "#0072BC", system: "Muni Metro" }, { name: "L", color: "#FFC72C", system: "Muni Metro" }, { name: "M", color: "#00A651", system: "Muni Metro" }, { name: "N", color: "#0039A6", system: "Muni Metro" }, { name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7847137, longitude: -122.4071968 },
  { name: "Van Ness", lines: [{ name: "J", color: "#522398", system: "Muni Metro" }, { name: "K", color: "#0072BC", system: "Muni Metro" }, { name: "L", color: "#FFC72C", system: "Muni Metro" }, { name: "M", color: "#00A651", system: "Muni Metro" }, { name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7751897, longitude: -122.4192659 },
  { name: "Arleta", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7123703, longitude: -122.4018994 },
  { name: "Carroll", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7254837, longitude: -122.3942674 },
  { name: "Evans", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.742715, longitude: -122.3879459 },
  { name: "Gilman/Paul", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7224125, longitude: -122.3956586 },
  { name: "Hudson/Innes", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7399474, longitude: -122.3888966 },
  { name: "Kirkwood/La Salle", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7375275, longitude: -122.3897643 },
  { name: "Le Conte", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.718533, longitude: -122.3978044 },
  { name: "Marin Street", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7490293, longitude: -122.3874868 },
  { name: "Oakdale/Palou", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7343961, longitude: -122.3908628 },
  { name: "Revere/Shafter", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7320706, longitude: -122.3916755 },
  { name: "Sunnydale", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7092072, longitude: -122.4049659 },
  { name: "UCSF Medical Center", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7643313, longitude: -122.388869 },
  { name: "Williams", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7292511, longitude: -122.3926636 },
  { name: "20th Street", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7604997, longitude: -122.3885771 },
  { name: "Balboa Park", lines: [{ name: "J", color: "#522398", system: "Muni Metro" }, { name: "K", color: "#0072BC", system: "Muni Metro" }, { name: "M", color: "#00A651", system: "Muni Metro" }], latitude: 37.7208729, longitude: -122.4467134 },
  { name: "City College", lines: [{ name: "K", color: "#0072BC", system: "Muni Metro" }], latitude: 37.7229972, longitude: -122.4511756 },
  { name: "Junipero Serra Boulevard & Ocean Avenue", lines: [{ name: "K", color: "#0072BC", system: "Muni Metro" }], latitude: 37.7314327, longitude: -122.4717726 },
  { name: "Ocean Avenue & Lee Avenue", lines: [{ name: "K", color: "#0072BC", system: "Muni Metro" }], latitude: 37.7234456, longitude: -122.454108 },
  { name: "Saint Francis Circle", lines: [{ name: "K", color: "#0072BC", system: "Muni Metro" }, { name: "M", color: "#00A651", system: "Muni Metro" }], latitude: 37.7353364, longitude: -122.4713392 },
  { name: "Church Street & 18th Street", lines: [{ name: "J", color: "#522398", system: "Muni Metro" }], latitude: 37.7612999, longitude: -122.4283361 },
  { name: "Church Street & 24th Street", lines: [{ name: "J", color: "#522398", system: "Muni Metro" }], latitude: 37.7516987, longitude: -122.4274526 },
  { name: "Church Street & Day Street", lines: [{ name: "J", color: "#522398", system: "Muni Metro" }], latitude: 37.7429019, longitude: -122.4266069 },
  { name: "San Jose Avenue & Randall Street", lines: [{ name: "J", color: "#522398", system: "Muni Metro" }], latitude: 37.7395066, longitude: -122.4242748 },
  { name: "Duboce Avenue & Church Street", lines: [{ name: "J", color: "#522398", system: "Muni Metro" }], latitude: 37.7694503, longitude: -122.4291697 },
  { name: "Duboce Avenue & Noe Street", lines: [{ name: "J", color: "#522398", system: "Muni Metro" }], latitude: 37.7693083, longitude: -122.4336698 },
  { name: "Judah Street & 9th Avenue", lines: [{ name: "N", color: "#0039A6", system: "Muni Metro" }], latitude: 37.7621741, longitude: -122.46644 },
  { name: "Judah Street & 28th Avenue", lines: [{ name: "N", color: "#0039A6", system: "Muni Metro" }], latitude: 37.7612828, longitude: -122.4866522 },
  { name: "Judah Street & La Playa Street", lines: [{ name: "N", color: "#0039A6", system: "Muni Metro" }], latitude: 37.7603214, longitude: -122.508632 },
  { name: "Judah Street & Sunset Boulevard", lines: [{ name: "N", color: "#0039A6", system: "Muni Metro" }], latitude: 37.76088, longitude: -122.495769 },
  { name: "Judah Street & 19th Avenue", lines: [{ name: "N", color: "#0039A6", system: "Muni Metro" }], latitude: 37.761708, longitude: -122.477032 },
  { name: "Carl Street & Cole Street", lines: [{ name: "N", color: "#0039A6", system: "Muni Metro" }], latitude: 37.7658084, longitude: -122.4499754 },
  { name: "UCSF Parnassus", lines: [{ name: "N", color: "#0039A6", system: "Muni Metro" }], latitude: 37.7643929, longitude: -122.4583938 },
  { name: "West Portal", lines: [{ name: "K", color: "#0072BC", system: "Muni Metro" }, { name: "L", color: "#FFC72C", system: "Muni Metro" }, { name: "M", color: "#00A651", system: "Muni Metro" }, { name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7411405, longitude: -122.4656336 },
  { name: "Taraval Street & 22nd Avenue", lines: [{ name: "L", color: "#FFC72C", system: "Muni Metro" }], latitude: 37.7428892, longitude: -122.479458 },
  { name: "Wawona Street & 46th Avenue", lines: [{ name: "L", color: "#FFC72C", system: "Muni Metro" }], latitude: 37.7361113, longitude: -122.504565 },
  { name: "Taraval Street & Sunset Boulevard", lines: [{ name: "L", color: "#FFC72C", system: "Muni Metro" }], latitude: 37.7422281, longitude: -122.494461 },
  { name: "Ocean Avenue & Jules Avenue", lines: [{ name: "K", color: "#0072BC", system: "Muni Metro" }], latitude: 37.7249647, longitude: -122.4612321 },
  { name: "Broad Street & Plymouth Avenue", lines: [{ name: "K", color: "#0072BC", system: "Muni Metro" }], latitude: 37.7131984, longitude: -122.4560697 },
  { name: "Randolph Street & Arch Street", lines: [{ name: "K", color: "#0072BC", system: "Muni Metro" }], latitude: 37.7142778, longitude: -122.467109 },
  { name: "Church Street & Market Street", lines: [{ name: "J", color: "#522398", system: "Muni Metro" }], latitude: 37.767115, longitude: -122.4288861 },
  { name: "Fourth/Brannan", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7786814, longitude: -122.396989 },
  { name: "Forest Hill", lines: [{ name: "K", color: "#0072BC", system: "Muni Metro" }, { name: "L", color: "#FFC72C", system: "Muni Metro" }, { name: "M", color: "#00A651", system: "Muni Metro" }, { name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.747987, longitude: -122.4591161 },
  { name: "Yerba Buena/Moscone", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.7822253, longitude: -122.401731 },
  { name: "Union Square/Market Street", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.786846, longitude: -122.40645 },
  { name: "Chinatown-Rose Pak", lines: [{ name: "T", color: "#BE0000", system: "Muni Metro" }], latitude: 37.794808, longitude: -122.408071 },
  { name: "Church Street & 28th Street", lines: [{ name: "J", color: "#522398", system: "Muni Metro" }], latitude: 37.7452943, longitude: -122.4268442 },
  { name: "Church Street & 26th Street", lines: [{ name: "J", color: "#522398", system: "Muni Metro" }], latitude: 37.7484849, longitude: -122.4271483 },
];

const CALTRAIN_STATIONS: TransitStation[] = [
  { name: "Morgan Hill", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.129664465000076, longitude: -121.65053101399997 },
  { name: "Gilroy", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.00444841800004, longitude: -121.566843614 },
  { name: "22nd St", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.757357859000024, longitude: -122.39274564799996 },
  { name: "Bayshore", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.70933591700003, longitude: -122.40132339499996 },
  { name: "South San Francisco", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.656226883000045, longitude: -122.405052502 },
  { name: "San Bruno", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.623802572000045, longitude: -122.40796626699995 },
  { name: "Millbrae", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.60018022200006, longitude: -122.38707065999995 },
  { name: "Broadway", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.58751026300007, longitude: -122.36296816999999 },
  { name: "Burlingame", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.57978724700007, longitude: -122.34471166399999 },
  { name: "San Mateo", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.568421503000025, longitude: -122.32412063299995 },
  { name: "Hayward Park", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.553157362000036, longitude: -122.30956296699998 },
  { name: "Hillsdale", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.53799807400003, longitude: -122.29793524599995 },
  { name: "Belmont", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.52092801900005, longitude: -122.27614561799999 },
  { name: "San Carlos", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.507281910000074, longitude: -122.25982635099996 },
  { name: "Redwood City", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.485951245000024, longitude: -122.23189551899998 },
  { name: "Atherton", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.46440788700005, longitude: -122.19781504599996 },
  { name: "Menlo Park", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.45513808900006, longitude: -122.18309769999996 },
  { name: "Palo Alto", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.443391751000036, longitude: -122.16501773899995 },
  { name: "Mountain View", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.39464963700004, longitude: -122.07672988499996 },
  { name: "Sunnyvale", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.37878256400006, longitude: -122.03142302699996 },
  { name: "Lawrence", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.370551223000064, longitude: -121.99721549599997 },
  { name: "Santa Clara", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.35346923700007, longitude: -121.936669097 },
  { name: "College Park", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.34299413300005, longitude: -121.91542846799996 },
  { name: "San Jose Diridon", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.33034938800006, longitude: -121.90309108799994 },
  { name: "Tamien", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.31193325800007, longitude: -121.88404861199996 },
  { name: "Capitol", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.28393045400003, longitude: -121.84184180099999 },
  { name: "Blossom Hill", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.25283912200007, longitude: -121.79750236199999 },
  { name: "San Martin", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.08696860400005, longitude: -121.61104450599998 },
  { name: "California Avenue", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.429210761000036, longitude: -122.14183362799997 },
  { name: "San Francisco", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.77659631500006, longitude: -122.39478193199994 },
  { name: "San Antonio", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.40751114600005, longitude: -122.10751300799996 },
  { name: "Stanford Stadium", lines: [{ name: "Caltrain", color: "#DA291C", system: "Caltrain" }], latitude: 37.43839865800004, longitude: -122.15644193999998 },
];

const VTA_STATIONS: TransitStation[] = [
  { name: "Santa Teresa Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }], latitude: 37.236668, longitude: -121.789141 },
  { name: "Cottle Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }], latitude: 37.242732, longitude: -121.803159 },
  { name: "Snell Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }], latitude: 37.248055, longitude: -121.831339 },
  { name: "Blossom Hill Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }], latitude: 37.25315, longitude: -121.841811 },
  { name: "Ohlone-Chynoweth Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }], latitude: 37.257993, longitude: -121.859666 },
  { name: "Branham Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }], latitude: 37.267296, longitude: -121.859381 },
  { name: "Capitol Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }], latitude: 37.275293, longitude: -121.863269 },
  { name: "Curtner Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }], latitude: 37.293955, longitude: -121.872703 },
  { name: "Tamien Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }], latitude: 37.311927, longitude: -121.884809 },
  { name: "Virginia Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }], latitude: 37.319828, longitude: -121.890104 },
  { name: "Children's Discovery Museum Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }], latitude: 37.327765, longitude: -121.893665 },
  { name: "Convention Center Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }, { name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.330168, longitude: -121.889754 },
  { name: "San Antonio Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }, { name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.332782, longitude: -121.887979 },
  { name: "Santa Clara Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }, { name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.335924, longitude: -121.890354 },
  { name: "Saint James Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }, { name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.338402, longitude: -121.892183 },
  { name: "Japantown/Ayer Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }, { name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.345557, longitude: -121.897559 },
  { name: "Civic Center Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }, { name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.352016, longitude: -121.902434 },
  { name: "Gish Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }, { name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.362544, longitude: -121.91016 },
  { name: "Metro/Airport Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }, { name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.370364, longitude: -121.91599 },
  { name: "Karina Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }, { name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.376278, longitude: -121.920405 },
  { name: "Component Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }, { name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.383483, longitude: -121.925777 },
  { name: "Bonaventura Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }, { name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.388749, longitude: -121.929742 },
  { name: "Orchard Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }, { name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.39573, longitude: -121.934869 },
  { name: "River Oaks Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }, { name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.402847, longitude: -121.940027 },
  { name: "Tasman Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }, { name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.408669, longitude: -121.944463 },
  { name: "Baypointe Station", lines: [{ name: "VTA Blue", color: "#007ACC", system: "VTA" }, { name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.410877, longitude: -121.941523 },
  { name: "Winchester Station", lines: [{ name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.27961, longitude: -121.947906 },
  { name: "Campbell Station", lines: [{ name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.2859, longitude: -121.943027 },
  { name: "Hamilton Station", lines: [{ name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.294064, longitude: -121.936167 },
  { name: "Bascom Station", lines: [{ name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.299851, longitude: -121.92983 },
  { name: "Fruitdale Station", lines: [{ name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.310482, longitude: -121.918017 },
  { name: "Race Station", lines: [{ name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.317567, longitude: -121.910314 },
  { name: "Diridon Station", lines: [{ name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.328947, longitude: -121.903511 },
  { name: "San Fernando Station", lines: [{ name: "VTA Green", color: "#379400", system: "VTA" }], latitude: 37.330367, longitude: -121.898116 },
  { name: "Champion Station", lines: [{ name: "VTA Green", color: "#379400", system: "VTA" }, { name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.409423, longitude: -121.952616 },
  { name: "Lick Mill Station", lines: [{ name: "VTA Green", color: "#379400", system: "VTA" }, { name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.407616, longitude: -121.963679 },
  { name: "Great America Station", lines: [{ name: "VTA Green", color: "#379400", system: "VTA" }, { name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.403468, longitude: -121.974908 },
  { name: "Old Ironsides Station", lines: [{ name: "VTA Green", color: "#379400", system: "VTA" }, { name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.403309, longitude: -121.979862 },
  { name: "Mountain View Station", lines: [{ name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.395283, longitude: -122.077596 },
  { name: "Whisman Station", lines: [{ name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.392205, longitude: -122.05822 },
  { name: "Middlefield Station", lines: [{ name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.39607, longitude: -122.051959 },
  { name: "Bayshore Nasa Station", lines: [{ name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.404327, longitude: -122.049167 },
  { name: "Moffett Park Station", lines: [{ name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.402367, longitude: -122.03346 },
  { name: "Lockheed Martin Station", lines: [{ name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.410048, longitude: -122.026891 },
  { name: "Borregas Station", lines: [{ name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.411326, longitude: -122.016702 },
  { name: "Crossman Station", lines: [{ name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.408841, longitude: -122.01118 },
  { name: "Fair Oaks Station", lines: [{ name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.402578, longitude: -122.008638 },
  { name: "Vienna Station", lines: [{ name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.403354, longitude: -121.998254 },
  { name: "Reamwood Station", lines: [{ name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.40351, longitude: -121.987407 },
  { name: "Cisco Station", lines: [{ name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.412348, longitude: -121.928312 },
  { name: "Alder Station", lines: [{ name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.413572, longitude: -121.917118 },
  { name: "Great Mall Station", lines: [{ name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.413925, longitude: -121.901434 },
  { name: "Milpitas Station", lines: [{ name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.408549, longitude: -121.890618 },
  { name: "Cropley Station", lines: [{ name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.402644, longitude: -121.881069 },
  { name: "Hostetter Station", lines: [{ name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.395649, longitude: -121.87029 },
  { name: "Berryessa Station", lines: [{ name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.387386, longitude: -121.861477 },
  { name: "Penitencia Creek Station", lines: [{ name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.380958, longitude: -121.854417 },
  { name: "Mckee Station", lines: [{ name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.371057, longitude: -121.844036 },
  { name: "Alum Rock Station", lines: [{ name: "VTA Orange", color: "#CC6600", system: "VTA" }], latitude: 37.358134, longitude: -121.83212 },
];

async function fetchBayAreaStations(): Promise<TransitStation[]> {
  const bart = await fetchBartStations();
  return [...bart, ...MUNI_METRO_STATIONS, ...CALTRAIN_STATIONS, ...VTA_STATIONS];
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
      const line: TransitLine = { name: route.color, color: route.hexcolor, system: "BART" };
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
  sfbay: fetchBayAreaStations,
  losangeles: fetchLaMetroStations,
};

const cache = new Map<string, { fetchedAt: number; stations: TransitStation[] }>();

function diskCacheKey(city: string): string {
  return `transit-stations-${city}`;
}

export function clearTransitStationsCache(): void {
  cache.clear();
  for (const city of Object.keys(FETCHERS)) clearDiskCache(diskCacheKey(city));
}

// Dedupes concurrent cache-miss callers for the same city. Without this, a
// single request enriching hundreds of listings against a cold cache (fresh
// deploy, TTL rollover) would have every one of them race past the cache
// checks below and fire its own real fetch — the same "hundreds of
// concurrent outbound requests" class of bug that already caused a
// production OOM crash, just triggered by cache cold-start instead of a bare
// Promise.all over listings.
const pendingFetches = new Map<string, Promise<TransitStation[]>>();

async function getStationsForCity(city: string): Promise<TransitStation[]> {
  const cached = cache.get(city);
  if (cached && Date.now() - cached.fetchedAt < STATIONS_TTL_MS) {
    return cached.stations;
  }

  // Disk cache survives dev server restarts — in-memory alone means every
  // restart re-fetches live, which is how these free public APIs' rate
  // limits get tripped during a long dev session.
  const onDisk = readDiskCache<TransitStation[]>(diskCacheKey(city), STATIONS_TTL_MS);
  if (onDisk) {
    cache.set(city, { fetchedAt: Date.now(), stations: onDisk });
    return onDisk;
  }

  const pending = pendingFetches.get(city);
  if (pending) return pending;

  const fetcher = FETCHERS[city];
  if (!fetcher) return [];

  const promise = (async () => {
    try {
      const stations = await fetcher();
      cache.set(city, { fetchedAt: Date.now(), stations });
      writeDiskCache(diskCacheKey(city), stations);
      return stations;
    } catch (err) {
      console.error(`Failed to fetch transit stations for ${city}:`, err);
      return cached?.stations ?? readDiskCacheStale<TransitStation[]>(diskCacheKey(city)) ?? [];
    } finally {
      pendingFetches.delete(city);
    }
  })();

  pendingFetches.set(city, promise);
  return promise;
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
