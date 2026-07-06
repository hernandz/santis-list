"use client";

import { useEffect, useState } from "react";
import { ClearCacheButton } from "./ClearCacheButton";
import { applyTheme, getStoredTheme, type Theme } from "@/lib/theme";

type Settings = {
  workAddress: string | null;
  workLatitude: number | null;
  workLongitude: number | null;
  useGoogleDirections: boolean;
};

type AddressSuggestion = { latitude: number; longitude: number; displayName: string };

const empty: Settings = {
  workAddress: null,
  workLatitude: null,
  workLongitude: null,
  useGoogleDirections: false,
};

export default function SettingsPage() {
  const [values, setValues] = useState<Settings>(empty);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [addressDirty, setAddressDirty] = useState(false);
  const [confirmedAddress, setConfirmedAddress] = useState<AddressSuggestion | null>(null);
  const [confirmPassword, setConfirmPassword] = useState("");
  // Starts as "auto" to match the server-rendered markup exactly (no access
  // to localStorage during SSR) — corrected right after mount, before the
  // user could plausibly interact with it.
  const [theme, setTheme] = useState<Theme>("auto");

  useEffect(() => {
    // Reading localStorage (an external system unavailable during SSR) is
    // exactly the documented exception to "don't setState in an effect".
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(getStoredTheme());
  }, []);

  function handleThemeChange(next: Theme) {
    setTheme(next);
    applyTheme(next);
  }

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((res) => res.json())
      .then((body) => setValues({ ...empty, ...body }))
      .finally(() => setLoading(false));
  }, []);

  // Debounced address autocomplete — only runs once the user has actually
  // edited the field (not on the initial value loaded from the server), and
  // waits for typing to pause before hitting Nominatim (whose usage policy
  // caps requests at 1/sec).
  useEffect(() => {
    const address = values.workAddress?.trim();
    if (!addressDirty || !address || address.length < 3) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/settings/geocode?q=${encodeURIComponent(address)}`, { cache: "no-store" });
        const body = await res.json();
        if (!cancelled) setSuggestions(body.results ?? []);
      } catch {
        if (!cancelled) setSuggestions([]);
      }
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [values.workAddress, addressDirty]);

  function selectSuggestion(s: AddressSuggestion) {
    setValues((prev) => ({ ...prev, workAddress: s.displayName }));
    setConfirmedAddress(s);
    setSuggestions([]);
    setAddressDirty(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);

    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workAddress: values.workAddress?.trim() || null,
        useGoogleDirections: values.useGoogleDirections,
        ...(values.useGoogleDirections ? { confirmPassword } : {}),
      }),
    });

    setSaving(false);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(typeof body.error === "string" ? body.error : JSON.stringify(body.error ?? "Something went wrong"));
      return;
    }

    const body = await res.json();
    setValues(body);
    setConfirmPassword("");
    setSaved(true);
  }

  if (loading) return <p className="text-sm text-black/50 dark:text-white/50">Loading…</p>;

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Deployment-wide defaults — a fallback commute origin for browsing and for anyone who sets up alerts
          without giving their own work address. Email alerts themselves are set up per saved search, not here.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {saved && <p className="text-sm text-green-600">Saved.</p>}

        <label className="flex flex-col gap-1 text-sm relative">
          Work address
          <input
            placeholder="e.g. 200 Park Ave, New York, NY"
            className="border rounded px-2 py-1 border-black/15 dark:border-white/20 bg-transparent"
            value={values.workAddress ?? ""}
            onChange={(e) => {
              setValues((prev) => ({ ...prev, workAddress: e.target.value }));
              setConfirmedAddress(null);
              setAddressDirty(true);
              if (e.target.value.trim().length < 3) setSuggestions([]);
            }}
          />
          {suggestions.length > 0 && (
            <ul className="absolute top-full mt-1 left-0 right-0 z-10 border rounded bg-background border-black/15 dark:border-white/20 divide-y divide-black/5 dark:divide-white/10 shadow-sm">
              {suggestions.map((s) => (
                <li key={`${s.latitude},${s.longitude}`}>
                  <button
                    type="button"
                    onClick={() => selectSuggestion(s)}
                    className="w-full text-left px-2 py-1.5 text-xs hover:bg-black/[.03] dark:hover:bg-white/[.05]"
                  >
                    {s.displayName}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <span className="text-xs text-black/50 dark:text-white/50">
            Used to compute the commute time/distance column on the listings feed. Pick a suggestion to confirm
            it resolved to the right place, or just save and it&apos;ll be geocoded automatically.
          </span>
        </label>

        {confirmedAddress && (
          <p className="text-xs text-green-600">
            Confirmed: {confirmedAddress.displayName} ({confirmedAddress.latitude.toFixed(5)},{" "}
            {confirmedAddress.longitude.toFixed(5)})
          </p>
        )}

        {!confirmedAddress && values.workLatitude != null && values.workLongitude != null && (
          <p className="text-xs text-black/50 dark:text-white/50">
            Currently located at {values.workLatitude.toFixed(5)}, {values.workLongitude.toFixed(5)}
          </p>
        )}

        <div className="border border-black/10 dark:border-white/15 rounded-lg p-4 flex flex-col gap-2">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={values.useGoogleDirections}
              onChange={(e) => setValues((prev) => ({ ...prev, useGoogleDirections: e.target.checked }))}
            />
            <span>
              Use the Google Directions API for real car/bike/transit routing
              <br />
              <span className="text-xs text-black/50 dark:text-white/50">
                Costs money past Google&apos;s free tier — off by default. When off, commute estimates use free
                alternatives (OSRM for car/bike, a walk-to-station heuristic for transit) instead.
              </span>
            </span>
          </label>
          {values.useGoogleDirections && (
            <label className="flex flex-col gap-1 text-sm mt-1">
              App password (required to enable this)
              <input
                type="password"
                className="border rounded px-2 py-1 border-black/15 dark:border-white/20 bg-transparent"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </label>
          )}
        </div>

        <button
          type="submit"
          disabled={saving}
          className="self-start px-4 py-2 rounded bg-foreground text-background disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
      </form>

      <div className="border border-black/10 dark:border-white/15 rounded-lg p-4 flex flex-col gap-2">
        <span className="text-sm">Theme</span>
        <div className="flex gap-2">
          {(["light", "dark", "auto"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => handleThemeChange(option)}
              className={`px-3 py-1.5 rounded text-sm border ${
                theme === option
                  ? "bg-foreground text-background border-foreground"
                  : "border-black/15 dark:border-white/20"
              }`}
            >
              {option === "auto" ? "Follow system" : option === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
        <p className="text-xs text-black/50 dark:text-white/50">Applies immediately, saved to this browser.</p>
      </div>

      <details className="border border-black/10 dark:border-white/15 rounded-lg px-4 py-3">
        <summary className="text-sm cursor-pointer select-none text-black/60 dark:text-white/60">
          Maintenance
        </summary>
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-xs text-black/50 dark:text-white/50">
            Clears cached transit/boundary/location data and the crawler&apos;s backoff state, then runs a fresh
            crawl. Only needed after underlying data changes (new subway line, updated city boundaries) or if
            the crawler got stuck backing off after repeated failures.
          </p>
          <ClearCacheButton />
        </div>
      </details>
    </div>
  );
}
