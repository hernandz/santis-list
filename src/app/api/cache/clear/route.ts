import { NextResponse } from "next/server";
import { clearTransitStationsCache } from "@/server/geo/transitStations";
import { clearNeighborhoodBoundariesCache } from "@/server/geo/neighborhoodBoundaries";
import { clearCraigslistLocationsCache } from "@/server/crawl/craigslistDirectory";
import { resetCircuitBreaker } from "@/server/crawl/sources/craigslist";

export const dynamic = "force-dynamic";

export async function POST() {
  clearTransitStationsCache();
  clearNeighborhoodBoundariesCache();
  clearCraigslistLocationsCache();
  resetCircuitBreaker();
  return NextResponse.json({ ok: true });
}
