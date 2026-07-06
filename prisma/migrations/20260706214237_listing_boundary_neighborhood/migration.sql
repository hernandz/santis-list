-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "boundaryNeighborhood" TEXT;

-- CreateIndex
CREATE INDEX "Listing_city_boundaryNeighborhood_bedrooms_bathrooms_idx" ON "Listing"("city", "boundaryNeighborhood", "bedrooms", "bathrooms");
