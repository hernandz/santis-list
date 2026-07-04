"use client";

import { useEffect, useState } from "react";

type CrawlSummary = {
  watchesProcessed: number;
  watchesFailed: number;
  listingsSeen: number;
  newListings: number;
  matchesCreated: number;
  immediateNotificationsSent: number;
};

type CrawlStatus = {
  inProgress: boolean;
  lastResult: { summary: CrawlSummary; finishedAt: string; failed: boolean; error?: string } | null;
};

const POLL_MS = 15_000;

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

export function CrawlStatusBadge() {
  const [status, setStatus] = useState<CrawlStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch("/api/crawl/status", { cache: "no-store" });
        const body = await res.json();
        if (!cancelled) setStatus(body);
      } catch {
        // transient — keep showing the last known status rather than blanking it
      }
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!status) return null;

  if (status.inProgress) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-black/60 dark:text-white/60">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" aria-hidden />
        Crawling…
      </span>
    );
  }

  if (!status.lastResult) {
    return <span className="text-xs text-black/40 dark:text-white/40">No crawl yet</span>;
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
