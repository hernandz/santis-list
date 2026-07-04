-- AlterTable
ALTER TABLE "Watch" ADD COLUMN     "subareas" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "alertEmail" TEXT,
    "workAddress" TEXT,
    "workLatitude" DOUBLE PRECISION,
    "workLongitude" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);
