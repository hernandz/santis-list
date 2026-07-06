import "dotenv/config";
import { prisma } from "@/server/db/prisma";
import { runFullCityCrawl } from "@/server/crawl/runCrawlCycle";

async function main() {
  const summary = await runFullCityCrawl();
  console.log("Full-city crawl summary:", summary);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
