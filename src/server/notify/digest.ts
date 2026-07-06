import { prisma } from "@/server/db/prisma";
import { emailChannel } from "./email";
import type { NotificationListingPayload } from "./types";
import { getNotificationExtras, type WorkLocation } from "./commuteEnrichment";
import { mapWithConcurrency, COMMUTE_REQUEST_CONCURRENCY } from "@/server/geo/commute";
import { buildPauseUrl } from "@/lib/pauseToken";

// Keyed by frequency (not a single shared flag) so an HOURLY and a DAILY
// flush can run concurrently — they touch disjoint watch sets since a watch
// has exactly one notifyFrequency — while still preventing the same
// frequency from overlapping with itself. Without this, a manual
// `scripts/flush-digests-once.ts` run racing the in-process cron tick (or
// two replicas both ticking) could both read the same unnotified matches and
// both send before either commits `notified: true`, duplicating emails.
const flushInProgress: Record<"HOURLY" | "DAILY", boolean> = { HOURLY: false, DAILY: false };

async function flushDigest(frequency: "HOURLY" | "DAILY") {
  if (flushInProgress[frequency]) {
    console.warn(`Skipped ${frequency} digest flush — a flush for this frequency is already in progress.`);
    return { watchesNotified: 0 };
  }
  flushInProgress[frequency] = true;
  try {
    return await flushDigestUnguarded(frequency);
  } finally {
    flushInProgress[frequency] = false;
  }
}

async function flushDigestUnguarded(frequency: "HOURLY" | "DAILY") {
  // Deployment-wide fallback commute origin/billing toggle — each watch's
  // actual recipient and (optionally) its own work address come from its
  // own Profile instead, fetched alongside each watch below.
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const defaultWork: WorkLocation | null =
    settings?.workLatitude != null && settings?.workLongitude != null
      ? { latitude: settings.workLatitude, longitude: settings.workLongitude }
      : null;
  const useGoogle = settings?.useGoogleDirections ?? false;

  const watches = await prisma.watch.findMany({
    where: { isActive: true, notifyFrequency: frequency },
    include: {
      profile: true,
      matches: {
        where: { notified: false },
        include: { listing: true },
      },
    },
  });

  let watchesNotified = 0;

  for (const watch of watches) {
    if (watch.matches.length === 0) continue;
    // No profile means no one asked to be notified for this search — it
    // still crawls/matches for browsing, but there's nothing to send.
    if (!watch.profile?.email) continue;
    const toEmail = watch.profile.email;
    const work: WorkLocation | null =
      watch.profile.workLatitude != null && watch.profile.workLongitude != null
        ? { latitude: watch.profile.workLatitude, longitude: watch.profile.workLongitude }
        : defaultWork;

    const listings: NotificationListingPayload[] = await mapWithConcurrency(
      watch.matches,
      COMMUTE_REQUEST_CONCURRENCY,
      async (m) => {
        const extras = await getNotificationExtras(m.listing, work, useGoogle);
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
