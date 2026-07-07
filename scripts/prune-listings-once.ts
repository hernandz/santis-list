import "dotenv/config";
import { prisma } from "@/server/db/prisma";
import { pruneOldListings } from "@/server/crawl/runCrawlCycle";

async function main() {
  const summary = await pruneOldListings();
  console.log("Prune summary:", summary);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
