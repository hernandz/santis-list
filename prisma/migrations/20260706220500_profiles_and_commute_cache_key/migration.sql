-- CreateTable
CREATE TABLE "Profile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "workAddress" TEXT,
    "workLatitude" DOUBLE PRECISION,
    "workLongitude" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Profile_email_key" ON "Profile"("email");

-- Data migration: the single existing Settings.alertEmail (if any) becomes a
-- real Profile, carrying over its work address too, and every pre-existing
-- Watch gets attached to it — preserving "alerts keep working" for whoever
-- was already relying on the old global alertEmail, instead of silently
-- going quiet after this deploy.
INSERT INTO "Profile" ("id", "name", "email", "workAddress", "workLatitude", "workLongitude")
SELECT gen_random_uuid()::text, split_part("alertEmail", '@', 1), "alertEmail", "workAddress", "workLatitude", "workLongitude"
FROM "Settings"
WHERE "id" = 'singleton' AND "alertEmail" IS NOT NULL;

-- AlterTable
ALTER TABLE "Watch" ADD COLUMN "profileId" TEXT;

UPDATE "Watch" SET "profileId" = (SELECT "id" FROM "Profile" LIMIT 1);

-- AlterTable
ALTER TABLE "Settings" DROP COLUMN "alertEmail";

-- AddForeignKey
ALTER TABLE "Watch" ADD CONSTRAINT "Watch_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DropIndex
DROP INDEX "CommuteCache_listingId_mode_key";

-- CreateIndex
CREATE UNIQUE INDEX "CommuteCache_listingId_mode_workLatitude_workLongitude_key" ON "CommuteCache"("listingId", "mode", "workLatitude", "workLongitude");
