import { prisma } from "@/server/db/prisma";
import type { CommuteEstimate } from "./commute";

// Backs the real (non-heuristic) car/bike/transit lookups in commute.ts —
// each one costs an external routing request (a paid one past Google's free
// tier for transit), and a listing's coordinates never change once geocoded,
// so the same (listing, mode) pair would otherwise get re-requested every
// time the feed is re-sorted, re-paged, or the map is reopened. Only ever
// stores approximate=false results — the heuristic transit fallback is
// already free/local, so there's no quota reason to cache it, and every
// entry read back is real by construction.
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // routes/schedules rarely change meaningfully day to day

type Work = { latitude: number; longitude: number };

// Work location is part of the lookup key itself now (not just checked
// after the fact) — see the schema comment on CommuteCache's unique index.
// Multiple people with different commute origins share this table, so a
// cached row only counts as a hit for the exact work location it was
// computed against; a since-changed address just misses and recomputes
// rather than silently serving someone else's commute.
function isFresh(row: { computedAt: Date }): boolean {
  return Date.now() - row.computedAt.getTime() < CACHE_TTL_MS;
}

export async function getCachedCommutes(
  listingIds: string[],
  mode: "car" | "bike" | "transit",
  work: Work,
): Promise<Map<string, CommuteEstimate>> {
  if (listingIds.length === 0) return new Map();

  const rows = await prisma.commuteCache.findMany({
    where: { listingId: { in: listingIds }, mode, workLatitude: work.latitude, workLongitude: work.longitude },
  });

  const result = new Map<string, CommuteEstimate>();
  for (const row of rows) {
    if (!isFresh(row)) continue;
    result.set(row.listingId, { minutes: row.minutes, distanceMiles: row.distanceMiles, approximate: false });
  }
  return result;
}

export async function saveCommutes(
  entries: { listingId: string; mode: "car" | "bike" | "transit"; estimate: CommuteEstimate }[],
  work: Work,
): Promise<void> {
  // Only real lookups are worth persisting — see the module comment above.
  const real = entries.filter((e) => !e.estimate.approximate);
  if (real.length === 0) return;

  await Promise.all(
    real.map((e) =>
      prisma.commuteCache.upsert({
        where: {
          listingId_mode_workLatitude_workLongitude: {
            listingId: e.listingId,
            mode: e.mode,
            workLatitude: work.latitude,
            workLongitude: work.longitude,
          },
        },
        create: {
          listingId: e.listingId,
          mode: e.mode,
          workLatitude: work.latitude,
          workLongitude: work.longitude,
          minutes: e.estimate.minutes,
          distanceMiles: e.estimate.distanceMiles,
        },
        update: {
          minutes: e.estimate.minutes,
          distanceMiles: e.estimate.distanceMiles,
          computedAt: new Date(),
        },
      }),
    ),
  );
}
