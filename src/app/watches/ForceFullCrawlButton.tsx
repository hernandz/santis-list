"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Same "wait for the response" pattern as ForceCrawlButton, but this one
// crawls every subarea of every supported city with no price filter — much
// bigger than a regular cycle, so it can genuinely take several minutes.
// The crawl itself isn't tied to the request finishing (it's a long-running
// container, not serverless), so even a browser timeout wouldn't stop it —
// just refresh /rent-map afterward if this tab gives up waiting first.
export function ForceFullCrawlButton() {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleClick() {
    setStatus("running");
    setMessage(null);

    const res = await fetch("/api/crawl/full-city", { method: "POST" });
    const body = await res.json();

    if (!res.ok) {
      setStatus("error");
      setMessage(body.error ?? "Full-city crawl failed");
      return;
    }

    setStatus("done");
    setMessage(`Checked every supported city, found ${body.newListings} new listing${body.newListings === 1 ? "" : "s"}.`);
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleClick}
        disabled={status === "running"}
        className="px-4 py-2 rounded border border-black/15 dark:border-white/20 text-sm disabled:opacity-50"
      >
        {status === "running" ? "Crawling every city… (can take a while)" : "Force full-city crawl"}
      </button>
      {message && (
        <p className={`text-xs ${status === "error" ? "text-red-600" : "text-black/60 dark:text-white/60"}`}>
          {message}
        </p>
      )}
    </div>
  );
}
