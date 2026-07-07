"use client";

import { useEffect, useRef, useState } from "react";

type CrawlSummary = {
  watchesProcessed: number;
  watchesFailed: number;
  listingsSeen: number;
  newListings: number;
  matchesCreated: number;
  immediateNotificationsSent: number;
};

type CrawlProgress = { total: number; done: number; currentWatchName: string | null };

type CrawlStatus = {
  inProgress: boolean;
  lastResult: { summary: CrawlSummary; finishedAt: string; failed: boolean; error?: string } | null;
  progress: CrawlProgress | null;
  mostRecentListingSeenAt: string | null;
  fullCrawlInProgress: boolean;
};

// Poll quickly while a crawl is actually running (so the progress bar feels
// live), fall back to an infrequent idle poll otherwise — a recursive
// setTimeout rather than setInterval so the delay can change between ticks.
const POLL_MS_ACTIVE = 2_000;
// A single watch crawls in single-digit seconds — 15s idle polling meant the
// badge could miss a whole short crawl between ticks and jump straight from
// idle to "finished" with no visible progress in between.
const POLL_MS_IDLE = 5_000;

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function exactTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function CrawlStatusBadge() {
  const [status, setStatus] = useState<CrawlStatus | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch("/api/crawl/status", { cache: "no-store" });
        const body: CrawlStatus = await res.json();
        if (cancelled) return;
        setStatus(body);
        timerRef.current = setTimeout(poll, body.inProgress || body.fullCrawlInProgress ? POLL_MS_ACTIVE : POLL_MS_IDLE);
      } catch {
        // transient — keep showing the last known status rather than blanking it
        if (!cancelled) timerRef.current = setTimeout(poll, POLL_MS_IDLE);
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!status) return null;

  if (status.fullCrawlInProgress) {
    return (
      <span
        className="flex items-center gap-1.5 text-xs text-black/60 dark:text-white/60"
        title="Crawling every subarea of every supported city with no price filter — can take several minutes."
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse shrink-0" aria-hidden />
        <span className="whitespace-nowrap">Full-city crawl running…</span>
      </span>
    );
  }

  if (status.inProgress) {
    const progress = status.progress;
    const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;
    return (
      <span className="flex items-center gap-1.5 text-xs text-black/60 dark:text-white/60">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse shrink-0" aria-hidden />
        <span className="whitespace-nowrap">
          Crawling{progress ? ` (${progress.done}/${progress.total})` : "…"}
        </span>
        {pct != null && (
          <span
            className="w-16 h-1.5 rounded-full bg-black/10 dark:bg-white/15 overflow-hidden shrink-0"
            title={progress?.currentWatchName ?? undefined}
          >
            <span className="block h-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
          </span>
        )}
      </span>
    );
  }

  if (!status.lastResult) {
    // lastResult only lives in memory and resets to null on every server
    // restart, even though crawling has continued for days — fall back to
    // real data freshness (derived from the DB, so it survives restarts)
    // instead of misleadingly claiming there's been no crawl at all.
    if (!status.mostRecentListingSeenAt) {
      return <span className="text-xs text-black/40 dark:text-white/40">No data yet</span>;
    }
    return (
      <span
        className="text-xs text-black/40 dark:text-white/40"
        title={`Data as of ${exactTimestamp(status.mostRecentListingSeenAt)}`}
      >
        Data as of {timeAgo(status.mostRecentListingSeenAt)}
      </span>
    );
  }

  const { summary, finishedAt, failed } = status.lastResult;

  if (failed) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-red-600" title={status.lastResult.error}>
        <span className="w-1.5 h-1.5 rounded-full bg-red-500" aria-hidden />
        Crawl failed {timeAgo(finishedAt)}
      </span>
    );
  }

  return (
    <span
      className="flex items-center gap-1.5 text-xs text-black/60 dark:text-white/60"
      title={`${summary.watchesProcessed} searches checked, ${summary.listingsSeen} listings seen, ${summary.matchesCreated} matches`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-green-500" aria-hidden />
      Last crawl {timeAgo(finishedAt)} · {summary.newListings} new
      {summary.watchesFailed > 0 ? ` · ${summary.watchesFailed} failed` : ""}
    </span>
  );
}
