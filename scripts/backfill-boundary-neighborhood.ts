import "dotenv/config";
import { prisma } from "@/server/db/prisma";
import { getNeighborhoodForPoint } from "@/server/geo/neighborhoodBoundaries";

async function main() {
  const listings = await prisma.listing.findMany({
    where: { boundaryNeighborhood: null, latitude: { not: null }, longitude: { not: null } },
  });
  console.log(`Backfilling boundaryNeighborhood for ${listings.length} listings...`);

  const perCity = new Map<string, { updated: number; unresolved: number; errored: number }>();
  function bucket(city: string) {
    if (!perCity.has(city)) perCity.set(city, { updated: 0, unresolved: 0, errored: 0 });
    return perCity.get(city)!;
  }

  let updated = 0;
  let unresolved = 0;
  let errored = 0;

  for (const listing of listings) {
    const stats = bucket(listing.city);
    try {
      const boundaryNeighborhood = await getNeighborhoodForPoint(listing.city, listing.latitude!, listing.longitude!);
      if (boundaryNeighborhood == null) {
        unresolved += 1;
        stats.unresolved += 1;
        continue;
      }
      await prisma.listing.update({ where: { id: listing.id }, data: { boundaryNeighborhood } });
      updated += 1;
      stats.updated += 1;
    } catch (err) {
      // Don't let one bad point (or a transient fetch failure) abort the
      // whole run — log it and keep going, same principle as the crawler's
      // own per-listing error handling.
      errored += 1;
      stats.errored += 1;
      console.error(`  ✗ ${listing.city} ${listing.id} (${listing.latitude}, ${listing.longitude}):`, err);
    }
  }

  console.log(`Done. Updated ${updated}, unresolved (no matching boundary) ${unresolved}, errored ${errored}.`);
  console.log("Per city:");
  for (const [city, stats] of perCity) {
    console.log(`  ${city}: updated ${stats.updated}, unresolved ${stats.unresolved}, errored ${stats.errored}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
