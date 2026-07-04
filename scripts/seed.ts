import "dotenv/config";
import { prisma } from "@/server/db/prisma";

async function main() {
  const watch = await prisma.watch.upsert({
    where: { id: "seed-watch-mission" },
    update: {
      city: "sfbay",
      neighborhoods: ["Mission"],
      minBedrooms: 1,
      maxPrice: 4000,
    },
    create: {
      id: "seed-watch-mission",
      name: "Mission District 1BR",
      city: "sfbay",
      neighborhoods: ["Mission"],
      minBedrooms: 1,
      maxPrice: 4000,
      notifyFrequency: "IMMEDIATE",
    },
  });
  console.log("Seeded watch:", watch);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
