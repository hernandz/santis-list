import Link from "next/link";
import { prisma } from "@/server/db/prisma";
import { DeleteWatchButton } from "./DeleteWatchButton";
import { ForceCrawlButton } from "./ForceCrawlButton";
import { PauseToggleButton } from "./PauseToggleButton";

export const dynamic = "force-dynamic";

export default async function WatchesPage() {
  const watches = await prisma.watch.findMany({ orderBy: { createdAt: "desc" } });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Saved Searches</h1>
          <p className="text-sm text-black/60 dark:text-white/60">
            Manage what gets crawled and how you&apos;re notified.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ForceCrawlButton />
          <Link href="/watches/new" className="px-4 py-2 rounded bg-foreground text-background text-sm h-fit">
            New saved search
          </Link>
        </div>
      </div>

      {watches.length === 0 && (
        <p className="text-sm text-black/50 dark:text-white/50">No saved searches yet.</p>
      )}

      <div className="flex flex-col divide-y divide-black/10 dark:divide-white/15 border border-black/10 dark:border-white/15 rounded-lg overflow-hidden">
        {watches.map((watch) => (
          <div key={watch.id} className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <div className="font-medium flex items-center gap-2">
                {watch.name}
                {!watch.isActive && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-black/10 dark:bg-white/10">paused</span>
                )}
              </div>
              <div className="text-xs text-black/60 dark:text-white/60">
                {watch.city}
                {watch.neighborhoods.length > 0 ? ` · ${watch.neighborhoods.join(", ")}` : " · whole city"}
                {watch.minPrice != null ? ` · min $${watch.minPrice}` : ""}
                {watch.maxPrice != null ? ` · max $${watch.maxPrice}` : ""}
                {watch.minBedrooms != null ? ` · ${watch.minBedrooms}+ bd` : ""}
                {watch.minBathrooms != null ? ` · ${watch.minBathrooms}+ ba` : ""}
                {` · ${watch.notifyFrequency.toLowerCase()}`}
              </div>
            </div>
            <div className="flex items-center gap-3 text-sm shrink-0">
              <Link href={`/watches/${watch.id}`} className="hover:underline">
                Edit
              </Link>
              <PauseToggleButton watchId={watch.id} isActive={watch.isActive} />
              <DeleteWatchButton watchId={watch.id} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
