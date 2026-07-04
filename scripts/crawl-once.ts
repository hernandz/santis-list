import "dotenv/config";
import { prisma } from "@/server/db/prisma";
import { runCrawlCycle } from "@/server/crawl/runCrawlCycle";

async function main() {
  const summary = await runCrawlCycle();
  console.log("Crawl summary:", summary);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
