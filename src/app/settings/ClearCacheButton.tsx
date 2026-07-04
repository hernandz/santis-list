"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Clears the server's in-memory caches (transit station data, neighborhood
// boundary polygons, live Craigslist location suggestions) and resets the
// crawler's circuit breaker, then immediately runs a fresh crawl cycle —
// useful if underlying data changed (new subway line, updated city boundary
// data) or the crawler got stuck backing off after repeated failures.
export function ClearCacheButton() {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleClick() {
    setStatus("running");
    setMessage(null);

    const clearRes = await fetch("/api/cache/clear", { method: "POST" });
    if (!clearRes.ok) {
      setStatus("error");
      setMessage("Failed to clear cache");
      return;
    }

    const crawlRes = await fetch("/api/crawl", { method: "POST" });
    const body = await crawlRes.json();

    if (!crawlRes.ok) {
      setStatus("error");
      setMessage(body.error ?? "Crawl failed after clearing cache");
      return;
    }

    setStatus(body.watchesFailed > 0 ? "error" : "done");
    setMessage(
      `Cache cleared. Checked ${body.watchesProcessed} search${body.watchesProcessed === 1 ? "" : "es"}, ` +
        `found ${body.newListings} new listing${body.newListings === 1 ? "" : "s"}` +
        (body.watchesFailed > 0 ? `, ${body.watchesFailed} search${body.watchesFailed === 1 ? "" : "es"} failed.` : "."),
    );
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        onClick={handleClick}
        disabled={status === "running"}
        className="px-4 py-2 rounded border border-black/15 dark:border-white/20 text-sm disabled:opacity-50"
      >
        {status === "running" ? "Clearing & re-searching…" : "Clear cache & re-search"}
      </button>
      {message && (
        <p className={`text-xs max-w-md ${status === "error" ? "text-red-600" : "text-black/60 dark:text-white/60"}`}>
          {message}
        </p>
      )}
    </div>
  );
}
