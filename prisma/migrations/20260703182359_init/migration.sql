-- CreateEnum
CREATE TYPE "ListingSourceType" AS ENUM ('CRAIGSLIST');

-- CreateEnum
CREATE TYPE "NotifyFrequency" AS ENUM ('IMMEDIATE', 'HOURLY', 'DAILY');

-- CreateEnum
CREATE TYPE "NotificationChannelType" AS ENUM ('EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('IMMEDIATE', 'DIGEST_HOURLY', 'DIGEST_DAILY');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "Watch" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "neighborhoodKeyword" TEXT,
    "minPrice" INTEGER,
    "maxPrice" INTEGER,
    "minBedrooms" INTEGER,
    "minBathrooms" INTEGER,
    "notifyFrequency" "NotifyFrequency" NOT NULL DEFAULT 'IMMEDIATE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Watch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "source" "ListingSourceType" NOT NULL DEFAULT 'CRAIGSLIST',
    "externalId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "price" INTEGER,
    "bedrooms" INTEGER,
    "bathrooms" DOUBLE PRECISION,
    "locationText" TEXT,
    "city" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawData" JSONB,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchMatch" (
    "id" TEXT NOT NULL,
    "watchId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "matchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "WatchMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "watchId" TEXT NOT NULL,
    "channel" "NotificationChannelType" NOT NULL DEFAULT 'EMAIL',
    "type" "NotificationType" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationListing" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,

    CONSTRAINT "NotificationListing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Listing_city_idx" ON "Listing"("city");

-- CreateIndex
CREATE INDEX "Listing_firstSeenAt_idx" ON "Listing"("firstSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_source_externalId_key" ON "Listing"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "WatchMatch_watchId_listingId_key" ON "WatchMatch"("watchId", "listingId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationListing_notificationId_listingId_key" ON "NotificationListing"("notificationId", "listingId");

-- AddForeignKey
ALTER TABLE "WatchMatch" ADD CONSTRAINT "WatchMatch_watchId_fkey" FOREIGN KEY ("watchId") REFERENCES "Watch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchMatch" ADD CONSTRAINT "WatchMatch_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_watchId_fkey" FOREIGN KEY ("watchId") REFERENCES "Watch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationListing" ADD CONSTRAINT "NotificationListing_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationListing" ADD CONSTRAINT "NotificationListing_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
