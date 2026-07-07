"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { VISIBLE_CITIES } from "@/lib/craigslistCities";

const RentMapClient = dynamic(() => import("./RentMapClient").then((m) => m.RentMapClient), {
  ssr: false,
  loading: () => (
    <div className="h-[36rem] w-full rounded-lg border border-black/10 dark:border-white/15 flex items-center justify-center text-sm text-black/50 dark:text-white/50">
      Loading map…
    </div>
  ),
});

const BEDROOM_OPTIONS = [
  { value: "0", label: "Studio" },
  { value: "1", label: "1 bedroom" },
  { value: "2", label: "2 bedrooms" },
  { value: "3", label: "3 bedrooms" },
  { value: "4", label: "4 bedrooms" },
];

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function RentMapPage() {
  const [city, setCity] = useState<string>(VISIBLE_CITIES[0]?.value ?? "newyork");
  const [bedrooms, setBedrooms] = useState("1");
  const [meta, setMeta] = useState<{ oldestListingAt: string | null; lastFullCrawlAt: string | null }>({
    oldestListingAt: null,
    lastFullCrawlAt: null,
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Rent Map</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Median rent by neighborhood for a given bedroom count — green is cheapest, red is priciest, yellow is
          the median neighborhood. Same real, verified neighborhood boundaries used across the rest of the app.
        </p>
        <p className="text-xs text-black/50 dark:text-white/50 mt-1">
          {formatDate(meta.oldestListingAt) ? <>Data goes back to {formatDate(meta.oldestListingAt)}</> : null}
          {formatDate(meta.oldestListingAt) && formatDate(meta.lastFullCrawlAt) ? " · " : null}
          {formatDate(meta.lastFullCrawlAt) ? <>Last full-city crawl {formatDate(meta.lastFullCrawlAt)}</> : null}
        </p>
      </div>

      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1 text-sm">
          City
          <select
            className="border rounded px-2 py-1 border-black/15 dark:border-white/20 bg-transparent"
            value={city}
            onChange={(e) => setCity(e.target.value)}
          >
            {VISIBLE_CITIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Bedrooms
          <select
            className="border rounded px-2 py-1 border-black/15 dark:border-white/20 bg-transparent"
            value={bedrooms}
            onChange={(e) => setBedrooms(e.target.value)}
          >
            {BEDROOM_OPTIONS.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <RentMapClient city={city} bedrooms={bedrooms} onMeta={setMeta} />
    </div>
  );
}
