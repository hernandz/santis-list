import "dotenv/config";
import { prisma } from "@/server/db/prisma";
import { flushHourlyDigests, flushDailyDigests } from "@/server/notify/digest";

async function main() {
  console.log("Hourly:", await flushHourlyDigests());
  console.log("Daily:", await flushDailyDigests());
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
