-- CreateTable
CREATE TABLE "CommuteCache" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "workLatitude" DOUBLE PRECISION NOT NULL,
    "workLongitude" DOUBLE PRECISION NOT NULL,
    "minutes" INTEGER NOT NULL,
    "distanceMiles" DOUBLE PRECISION NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommuteCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommuteCache_listingId_mode_key" ON "CommuteCache"("listingId", "mode");

-- AddForeignKey
ALTER TABLE "CommuteCache" ADD CONSTRAINT "CommuteCache_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
