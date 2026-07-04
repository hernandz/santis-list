-- AlterTable
ALTER TABLE "Watch" DROP COLUMN "neighborhoodKeyword",
DROP COLUMN "regionKeyword",
ADD COLUMN     "neighborhoods" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill existing rows (ALTER TABLE ADD COLUMN DEFAULT only applies to new rows)
UPDATE "Watch" SET "neighborhoods" = ARRAY[]::TEXT[] WHERE "neighborhoods" IS NULL;

ALTER TABLE "Watch" ALTER COLUMN "neighborhoods" SET NOT NULL;
