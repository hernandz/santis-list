import "dotenv/config";
import { prisma } from "@/server/db/prisma";
import { getNeighborhoodForPoint } from "@/server/geo/neighborhoodBoundaries";

async function main() {
  const listings = await prisma.listing.findMany({
    where: { boundaryNeighborhood: null, latitude: { not: null }, longitude: { not: null } },
  });
  console.log(`Backfilling boundaryNeighborhood for ${listings.length} listings...`);

  let updated = 0;
  let unresolved = 0;

  for (const listing of listings) {
    const boundaryNeighborhood = await getNeighborhoodForPoint(listing.city, listing.latitude!, listing.longitude!);
    if (boundaryNeighborhood == null) {
      unresolved += 1;
      continue;
    }
    await prisma.listing.update({ where: { id: listing.id }, data: { boundaryNeighborhood } });
    updated += 1;
  }

  console.log(`Done. Updated ${updated}, unresolved (no matching boundary) ${unresolved}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
