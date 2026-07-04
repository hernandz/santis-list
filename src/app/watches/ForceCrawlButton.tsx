"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function ForceCrawlButton() {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleClick() {
    setStatus("running");
    setMessage(null);

    const res = await fetch("/api/crawl", { method: "POST" });
    const body = await res.json();

    if (!res.ok) {
      setStatus("error");
      setMessage(body.error ?? "Crawl failed");
      return;
    }

    setStatus(body.watchesFailed > 0 ? "error" : "done");
    setMessage(
      `Checked ${body.watchesProcessed} search${body.watchesProcessed === 1 ? "" : "es"}, ` +
        `found ${body.newListings} new listing${body.newListings === 1 ? "" : "s"}, ` +
        `${body.matchesCreated} match${body.matchesCreated === 1 ? "" : "es"}` +
        (body.watchesFailed > 0 ? `, ${body.watchesFailed} search${body.watchesFailed === 1 ? "" : "es"} failed.` : "."),
    );
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleClick}
        disabled={status === "running"}
        className="px-4 py-2 rounded border border-black/15 dark:border-white/20 text-sm disabled:opacity-50"
      >
        {status === "running" ? "Crawling…" : "Recrawl now"}
      </button>
      {message && (
        <p className={`text-xs ${status === "error" ? "text-red-600" : "text-black/60 dark:text-white/60"}`}>
          {message}
        </p>
      )}
    </div>
  );
}
