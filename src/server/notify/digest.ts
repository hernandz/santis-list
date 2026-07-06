import { prisma } from "@/server/db/prisma";
import { emailChannel } from "./email";
import type { NotificationListingPayload } from "./types";
import { getNotificationExtras, type WorkLocation } from "./commuteEnrichment";
import { mapWithConcurrency, COMMUTE_REQUEST_CONCURRENCY } from "@/server/geo/commute";
import { buildPauseUrl } from "@/lib/pauseToken";

async function flushDigest(frequency: "HOURLY" | "DAILY") {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const toEmail = settings?.alertEmail || process.env.NOTIFY_TO_EMAIL;
  if (!toEmail) return { watchesNotified: 0 };

  const work: WorkLocation | null =
    settings?.workLatitude != null && settings?.workLongitude != null
      ? { latitude: settings.workLatitude, longitude: settings.workLongitude }
      : null;

  const watches = await prisma.watch.findMany({
    where: { isActive: true, notifyFrequency: frequency },
    include: {
      matches: {
        where: { notified: false },
        include: { listing: true },
      },
    },
  });

  let watchesNotified = 0;

  for (const watch of watches) {
    if (watch.matches.length === 0) continue;

    const listings: NotificationListingPayload[] = await mapWithConcurrency(
      watch.matches,
      COMMUTE_REQUEST_CONCURRENCY,
      async (m) => {
        const extras = await getNotificationExtras(m.listing, work);
        return {
          title: m.listing.title,
          url: m.listing.url,
          price: m.listing.price,
          bedrooms: m.listing.bedrooms,
          bathrooms: m.listing.bathrooms,
          locationText: m.listing.locationText,
          nearestStation: extras.nearestStation,
          commute: extras.commute,
        };
      },
    );

    const notification = await prisma.notification.create({
      data: {
        watchId: watch.id,
        channel: "EMAIL",
        type: frequency === "HOURLY" ? "DIGEST_HOURLY" : "DIGEST_DAILY",
        status: "PENDING",
      },
    });

    try {
      await emailChannel.send({
        to: toEmail,
        subject: `[santi's list] ${listings.length} new listing${listings.length > 1 ? "s" : ""} for "${watch.name}" (${frequency.toLowerCase()} digest)`,
        watchName: watch.name,
        listings,
        pauseUrl: buildPauseUrl(watch.id) ?? undefined,
      });

      await prisma.$transaction([
        prisma.notification.update({
          where: { id: notification.id },
          data: { status: "SENT", sentAt: new Date() },
        }),
        prisma.watchMatch.updateMany({
          where: { id: { in: watch.matches.map((m) => m.id) } },
          data: { notified: true },
        }),
      ]);
      watchesNotified += 1;
    } catch (err) {
      await prisma.notification.update({
        where: { id: notification.id },
        data: { status: "FAILED", errorMessage: err instanceof Error ? err.message : String(err) },
      });
      console.error(`Failed to send ${frequency} digest for watch ${watch.id}:`, err);
    }
  }

  return { watchesNotified };
}

export async function flushHourlyDigests() {
  return flushDigest("HOURLY");
}

export async function flushDailyDigests() {
  return flushDigest("DAILY");
}
