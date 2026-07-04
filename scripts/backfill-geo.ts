import "dotenv/config";
import { prisma } from "@/server/db/prisma";
import { craigslistSource, ListingGoneError } from "@/server/crawl/sources/craigslist";

async function main() {
  const listings = await prisma.listing.findMany({ where: { latitude: null } });
  console.log(`Backfilling geo data for ${listings.length} listings...`);

  let updated = 0;
  let gone = 0;
  let failed = 0;

  for (const listing of listings) {
    try {
      const details = await craigslistSource.fetchDetails(listing.url);
      await prisma.listing.update({
        where: { id: listing.id },
        data: {
          bedrooms: listing.bedrooms ?? details.bedrooms,
          bathrooms: listing.bathrooms ?? details.bathrooms,
          postedAt: listing.postedAt ?? details.postedAt,
          address: details.address,
          latitude: details.latitude,
          longitude: details.longitude,
        },
      });
      updated += 1;
      console.log(`  ✓ ${listing.title.slice(0, 50)} -> ${details.latitude}, ${details.longitude}`);
    } catch (err) {
      if (err instanceof ListingGoneError) {
        gone += 1;
        console.log(`  – ${listing.title.slice(0, 50)}: expired on Craigslist, skipping`);
        continue;
      }
      failed += 1;
      console.error(`  ✗ ${listing.title.slice(0, 50)}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`Done. Updated ${updated}, gone ${gone}, failed ${failed}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
