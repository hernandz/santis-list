"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { Geometry } from "geojson";
import { VISIBLE_CITIES } from "@/lib/craigslistCities";

const NeighborhoodMapPicker = dynamic(
  () => import("./NeighborhoodMapPicker").then((m) => m.NeighborhoodMapPicker),
  {
    ssr: false,
    loading: () => (
      <div className="h-80 w-full rounded-lg border border-black/10 dark:border-white/15 flex items-center justify-center text-sm text-black/50 dark:text-white/50">
        Loading map…
      </div>
    ),
  },
);

export type WatchFormValues = {
  name: string;
  city: string;
  subareas: string[];
  neighborhoods: string[];
  keyword: string;
  minPrice: string;
  maxPrice: string;
  minBedrooms: string;
  minBathrooms: string;
  notifyFrequency: "IMMEDIATE" | "HOURLY" | "DAILY";
  isActive: boolean;
  // Not stored fields themselves — see toPayload/resolveProfileId. alertsEnabled
  // just drives which of {alertName, alertEmail} vs {removeAlerts} gets sent.
  alertsEnabled: boolean;
  alertName: string;
  alertEmail: string;
};

const empty: WatchFormValues = {
  name: "",
  city: "newyork",
  subareas: [],
  neighborhoods: [],
  keyword: "",
  minPrice: "",
  maxPrice: "",
  minBedrooms: "",
  minBathrooms: "",
  notifyFrequency: "IMMEDIATE",
  isActive: true,
  alertsEnabled: false,
  alertName: "",
  alertEmail: "",
};

function toPayload(values: WatchFormValues) {
  return {
    name: values.name,
    city: values.city,
    subareas: values.subareas,
    neighborhoods: values.neighborhoods,
    keyword: values.keyword === "" ? null : values.keyword,
    minPrice: values.minPrice === "" ? null : Number(values.minPrice),
    maxPrice: values.maxPrice === "" ? null : Number(values.maxPrice),
    minBedrooms: values.minBedrooms === "" ? null : Number(values.minBedrooms),
    minBathrooms: values.minBathrooms === "" ? null : Number(values.minBathrooms),
    notifyFrequency: values.notifyFrequency,
    isActive: values.isActive,
    ...(values.alertsEnabled
      ? { alertName: values.alertName.trim(), alertEmail: values.alertEmail.trim() }
      : { removeAlerts: true }),
  };
}

function useCraigslistAreas(city: string): { code: string; label: string }[] {
  const [areas, setAreas] = useState<{ code: string; label: string }[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/craigslist/areas?city=${encodeURIComponent(city)}`, { cache: "no-store" });
        const body = await res.json();
        if (!cancelled) setAreas(body.areas ?? []);
      } catch {
        if (!cancelled) setAreas([]);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [city]);

  return areas;
}

type BoundaryData = { name: string; geometry: Geometry; region: string | null };

function useNeighborhoodBoundaries(city: string): BoundaryData[] {
  const [boundaries, setBoundaries] = useState<BoundaryData[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/craigslist/neighborhood-boundaries?city=${encodeURIComponent(city)}`, {
          cache: "no-store",
        });
        const body = await res.json();
        if (!cancelled) setBoundaries(body.boundaries ?? []);
      } catch {
        if (!cancelled) setBoundaries([]);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [city]);

  return boundaries;
}

function SubareaPicker({
  areas,
  selected,
  onChange,
}: {
  areas: { code: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  if (areas.length === 0) return null;

  function toggle(code: string) {
    onChange(selected.includes(code) ? selected.filter((c) => c !== code) : [...selected, code]);
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm">
        Craigslist sub-areas <span className="text-black/50 dark:text-white/50">(optional — narrows what gets crawled)</span>
      </span>
      <div className="flex flex-wrap gap-1.5">
        {areas.map((area) => (
          <button
            key={area.code}
            type="button"
            onClick={() => toggle(area.code)}
            className={`text-xs px-2 py-1 rounded-full border ${
              selected.includes(area.code)
                ? "bg-foreground text-background border-foreground"
                : "border-black/15 dark:border-white/20"
            }`}
          >
            {area.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-black/50 dark:text-white/50">
        Leave empty to search the whole metro. Picking sub-areas scopes Craigslist&apos;s own search to just
        those areas instead of its citywide recency window, so listings in a specific area are less likely to
        get crowded out by higher-volume areas.
      </p>
    </div>
  );
}

function NeighborhoodPicker({
  city,
  regions,
  selected,
  onChange,
}: {
  city: string;
  regions: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [allNeighborhoods, setAllNeighborhoods] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const regionsKey = regions.join(",");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const params = new URLSearchParams({ city });
        regionsKey
          .split(",")
          .filter(Boolean)
          .forEach((r) => params.append("region", r));
        const res = await fetch(`/api/craigslist/neighborhoods?${params.toString()}`, { cache: "no-store" });
        const body = await res.json();
        if (!cancelled) setAllNeighborhoods(body.neighborhoods ?? []);
      } catch {
        if (!cancelled) setAllNeighborhoods([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [city, regionsKey]);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = needle ? allNeighborhoods.filter((n) => n.toLowerCase().includes(needle)) : allNeighborhoods;
    return list.slice(0, 200);
  }, [allNeighborhoods, filter]);

  function toggle(name: string) {
    onChange(selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name]);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm">Neighborhoods (combine as many as you want — matches any of them)</span>
        {selected.length > 0 && (
          <button type="button" onClick={() => onChange([])} className="text-xs text-black/50 hover:underline">
            Clear all
          </button>
        )}
      </div>

      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => toggle(name)}
              className="text-xs px-2 py-1 rounded-full bg-foreground text-background flex items-center gap-1"
            >
              {name} <span aria-hidden>×</span>
            </button>
          ))}
        </div>
      )}

      <input
        placeholder={loading ? "Loading real neighborhoods for this city…" : "Filter neighborhoods…"}
        className="border rounded px-2 py-1 text-sm border-black/15 dark:border-white/20 bg-transparent"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      <div className="max-h-48 overflow-y-auto border rounded border-black/15 dark:border-white/20 divide-y divide-black/5 dark:divide-white/10">
        {filtered.map((name) => (
          <label
            key={name}
            className="flex items-center gap-2 px-2 py-1 text-sm hover:bg-black/[.03] dark:hover:bg-white/[.05] cursor-pointer"
          >
            <input type="checkbox" checked={selected.includes(name)} onChange={() => toggle(name)} />
            {name}
          </label>
        ))}
        {!loading && filtered.length === 0 && (
          <p className="px-2 py-2 text-xs text-black/50 dark:text-white/50">No neighborhoods match &quot;{filter}&quot;</p>
        )}
      </div>
      <p className="text-xs text-black/50 dark:text-white/50">
        Leave empty to watch the whole city with no neighborhood restriction. Boundaries are official city GIS
        data — a listing only matches if its real coordinates fall inside one of the selected neighborhoods (or
        if Craigslist didn&apos;t provide a map for that listing).
      </p>
    </div>
  );
}

export function WatchForm({
  watchId,
  initialValues,
}: {
  watchId?: string;
  initialValues?: Partial<WatchFormValues>;
}) {
  const router = useRouter();
  const [values, setValues] = useState<WatchFormValues>({ ...empty, ...initialValues });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Convenience only, not an identity/session — prefills name/email from
  // whatever this browser last used to set up alerts, so setting up a
  // second or third alerting search doesn't mean retyping the same email.
  // Never overrides values already loaded for an existing watch's own alerts.
  useEffect(() => {
    if (initialValues?.alertEmail) return;
    const lastName = localStorage.getItem("watch:lastAlertName");
    const lastEmail = localStorage.getItem("watch:lastAlertEmail");
    if (lastName || lastEmail) {
      // Reading localStorage (an external system unavailable during SSR) is
      // exactly the documented exception to "don't setState in an effect".
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setValues((prev) => ({ ...prev, alertName: lastName ?? prev.alertName, alertEmail: lastEmail ?? prev.alertEmail }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const areas = useCraigslistAreas(values.city);
  const boundaries = useNeighborhoodBoundaries(values.city);

  const subareaLabels = useMemo(
    () => areas.filter((a) => values.subareas.includes(a.code)).map((a) => a.label),
    [areas, values.subareas],
  );

  // Selected neighborhoods drive sub-area selection automatically: a sub-area
  // is just a crawl-scope hint, and the region(s) the chosen neighborhoods
  // actually belong to (NYC's borough field) is a more reliable signal than
  // asking the user to keep both in sync by hand. Only overrides when there's
  // something to derive — leaves manual picks alone with no neighborhoods
  // selected yet, or for cities without a region grouping (SF, LA).
  // Computed during render (React's documented "adjusting state when a prop
  // changes" pattern) rather than in an effect, to avoid the extra
  // commit-then-re-render round trip a useEffect+setState would cause.
  const neighborhoodsKey = values.neighborhoods.join(",");
  const syncKey = `${neighborhoodsKey}|${areas.length}|${boundaries.length}`;
  const [lastSyncKey, setLastSyncKey] = useState(syncKey);
  if (syncKey !== lastSyncKey) {
    setLastSyncKey(syncKey);

    if (values.neighborhoods.length > 0 && areas.length > 0 && boundaries.length > 0) {
      const regionsForSelection = new Set(
        boundaries.filter((b) => values.neighborhoods.includes(b.name) && b.region).map((b) => b.region as string),
      );
      const derivedCodes = areas
        .filter((a) => Array.from(regionsForSelection).some((r) => r.toLowerCase() === a.label.toLowerCase()))
        .map((a) => a.code);

      if (derivedCodes.length > 0) {
        const same =
          values.subareas.length === derivedCodes.length && derivedCodes.every((c) => values.subareas.includes(c));
        if (!same) setValues((prev) => ({ ...prev, subareas: derivedCodes }));
      }
    }
  }

  function set<K extends keyof WatchFormValues>(key: K, value: WatchFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function toggleNeighborhood(name: string) {
    setValues((prev) => ({
      ...prev,
      neighborhoods: prev.neighborhoods.includes(name)
        ? prev.neighborhoods.filter((n) => n !== name)
        : [...prev.neighborhoods, name],
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (values.alertsEnabled && (!values.alertName.trim() || !values.alertEmail.trim())) {
      setError("Name and email are required to turn on alerts for this search.");
      return;
    }

    setSubmitting(true);

    const res = await fetch(watchId ? `/api/watches/${watchId}` : "/api/watches", {
      method: watchId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toPayload(values)),
    });

    setSubmitting(false);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ? JSON.stringify(body.error) : "Something went wrong");
      return;
    }

    if (values.alertsEnabled) {
      localStorage.setItem("watch:lastAlertName", values.alertName.trim());
      localStorage.setItem("watch:lastAlertEmail", values.alertEmail.trim());
    }

    router.push("/watches");
    router.refresh();
  }

  return (
    <div className="flex flex-col lg:flex-row gap-6 items-start">
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 max-w-lg flex-1 min-w-0">
      {error && <p className="text-sm text-red-600">{error}</p>}

      <label className="flex flex-col gap-1 text-sm">
        Name
        <input
          required
          className="border rounded px-2 py-1 border-black/15 dark:border-white/20 bg-transparent"
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        City
        <select
          required
          className="border rounded px-2 py-1 border-black/15 dark:border-white/20 bg-transparent"
          value={values.city}
          onChange={(e) => {
            set("city", e.target.value);
            set("subareas", []);
            set("neighborhoods", []);
          }}
        >
          {VISIBLE_CITIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      <SubareaPicker
        areas={areas}
        selected={values.subareas}
        onChange={(next) => set("subareas", next)}
      />

      <NeighborhoodPicker
        city={values.city}
        // Pare-down is only a "browse faster" convenience for picking your
        // *first* neighborhood. Once neighborhoods are selected, sub-areas
        // auto-follow them (see the sync above) — re-applying that as a
        // filter here would trap the list to whichever borough was picked
        // first and hide neighborhoods from any other borough you'd want to
        // add next (e.g. Ridgewood/Queens after Bushwick/Brooklyn).
        regions={values.neighborhoods.length === 0 ? subareaLabels : []}
        selected={values.neighborhoods}
        onChange={(next) => set("neighborhoods", next)}
      />

      <label className="flex flex-col gap-1 text-sm">
        Keyword (optional — matches listing titles containing this text)
        <input
          className="border rounded px-2 py-1 border-black/15 dark:border-white/20 bg-transparent"
          placeholder="e.g. parking, pool"
          value={values.keyword}
          onChange={(e) => set("keyword", e.target.value)}
        />
      </label>

      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Min price
          <input
            type="number"
            className="border rounded px-2 py-1 border-black/15 dark:border-white/20 bg-transparent"
            value={values.minPrice}
            onChange={(e) => set("minPrice", e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Max price
          <input
            type="number"
            className="border rounded px-2 py-1 border-black/15 dark:border-white/20 bg-transparent"
            value={values.maxPrice}
            onChange={(e) => set("maxPrice", e.target.value)}
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Min bedrooms
          <input
            type="number"
            className="border rounded px-2 py-1 border-black/15 dark:border-white/20 bg-transparent"
            value={values.minBedrooms}
            onChange={(e) => set("minBedrooms", e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Min bathrooms
          <input
            type="number"
            step="0.5"
            className="border rounded px-2 py-1 border-black/15 dark:border-white/20 bg-transparent"
            value={values.minBathrooms}
            onChange={(e) => set("minBathrooms", e.target.value)}
          />
        </label>
      </div>

      <div className="border border-black/10 dark:border-white/15 rounded-lg p-4 flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={values.alertsEnabled}
            onChange={(e) => set("alertsEnabled", e.target.checked)}
          />
          Get email alerts for this search
        </label>
        <p className="text-xs text-black/50 dark:text-white/50">
          Leave unchecked to just crawl and browse this search with no emails — no name/email needed for that.
        </p>

        {values.alertsEnabled && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <label className="flex flex-col gap-1 text-sm">
                Your name
                <input
                  className="border rounded px-2 py-1 border-black/15 dark:border-white/20 bg-transparent"
                  value={values.alertName}
                  onChange={(e) => set("alertName", e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Your email
                <input
                  type="email"
                  className="border rounded px-2 py-1 border-black/15 dark:border-white/20 bg-transparent"
                  value={values.alertEmail}
                  onChange={(e) => set("alertEmail", e.target.value)}
                />
              </label>
            </div>

            <label className="flex flex-col gap-1 text-sm">
              Notify me
              <select
                className="border rounded px-2 py-1 border-black/15 dark:border-white/20 bg-transparent"
                value={values.notifyFrequency}
                onChange={(e) => set("notifyFrequency", e.target.value as WatchFormValues["notifyFrequency"])}
              >
                <option value="IMMEDIATE">Immediately, per listing</option>
                <option value="HOURLY">Hourly digest</option>
                <option value="DAILY">Daily digest</option>
              </select>
            </label>
          </>
        )}
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={values.isActive}
          onChange={(e) => set("isActive", e.target.checked)}
        />
        Active (crawl this search)
      </label>

      <button
        type="submit"
        disabled={submitting}
        className="self-start px-4 py-2 rounded bg-foreground text-background disabled:opacity-50"
      >
        {submitting ? "Saving…" : watchId ? "Save changes" : "Create saved search"}
      </button>
    </form>

    <div className="w-full lg:w-96 lg:sticky lg:top-4 flex flex-col gap-2">
      <span className="text-sm">Neighborhood map (click to toggle)</span>
      <NeighborhoodMapPicker
        city={values.city}
        boundaries={boundaries}
        selected={values.neighborhoods}
        onToggle={toggleNeighborhood}
      />
    </div>
    </div>
  );
}
