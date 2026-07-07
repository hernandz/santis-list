import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import { getNeighborhoodBoundaries } from "@/server/geo/neighborhoodBoundaries";

export const dynamic = "force-dynamic";

type RentRow = { neighborhood: string; median: number; min: number; max: number; count: bigint };

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const city = searchParams.get("city");
  const bedroomsParam = searchParams.get("bedrooms");
  if (!city || bedroomsParam == null) {
    return NextResponse.json({ error: "city and bedrooms query params are required" }, { status: 400 });
  }
  const bedrooms = Number(bedroomsParam);
  if (!Number.isFinite(bedrooms)) {
    return NextResponse.json({ error: "bedrooms must be a number" }, { status: 400 });
  }

  // One neighborhood-level query (not per-listing) — same median/min/max
  // stats as the per-listing price coloring on the feed, but grouped across
  // the whole city for one bedroom count instead of per-listing.
  const [rows, [{ oldest }], settings] = await Promise.all([
    prisma.$queryRaw<RentRow[]>`
      SELECT "boundaryNeighborhood" AS neighborhood,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY price) AS median,
             MIN(price) AS min,
             MAX(price) AS max,
             COUNT(*) AS count
      FROM "Listing"
      WHERE city = ${city} AND bedrooms = ${bedrooms} AND price IS NOT NULL AND "boundaryNeighborhood" IS NOT NULL
      GROUP BY "boundaryNeighborhood"
    `,
    // Oldest listing behind this exact map — postedAt (when it actually went
    // up on Craigslist) rather than firstSeenAt (when our crawler found it),
    // falling back to firstSeenAt for the rare listing whose detail-page
    // fetch never succeeded. Scoped to the same rows the map is built from,
    // so it reflects how far back this specific view's data goes.
    prisma.$queryRaw<{ oldest: Date | null }[]>`
      SELECT MIN(COALESCE("postedAt", "firstSeenAt")) AS oldest
      FROM "Listing"
      WHERE city = ${city} AND bedrooms = ${bedrooms} AND price IS NOT NULL AND "boundaryNeighborhood" IS NOT NULL
    `,
    prisma.settings.findUnique({ where: { id: "singleton" } }),
  ]);

  const statsByName = new Map(
    rows.map((r) => [
      r.neighborhood,
      { median: Number(r.median), min: Number(r.min), max: Number(r.max), count: Number(r.count) },
    ]),
  );

  const boundaries = await getNeighborhoodBoundaries(city);
  const neighborhoods = boundaries
    .filter((b) => statsByName.has(b.name))
    .map((b) => ({ name: b.name, geometry: b.geometry, region: b.region, ...statsByName.get(b.name)! }));

  return NextResponse.json(
    { neighborhoods, oldestListingAt: oldest, lastFullCrawlAt: settings?.lastFullCrawlAt ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
