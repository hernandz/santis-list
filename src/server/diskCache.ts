import fs from "node:fs";
import path from "node:path";

// A persistent, on-disk companion to the in-memory caches scattered around
// src/server/geo — those reset on every dev server restart (which happens a
// lot during development), forcing a live re-fetch each time and eventually
// tripping rate limits on the free public APIs backing them (NYC Open Data,
// MTA, etc.). This survives restarts, so a restart only means a live fetch
// if the data is actually stale, not every single time.
const CACHE_DIR = path.join(process.cwd(), ".cache");

function cachePath(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`);
}

export function readDiskCache<T>(key: string, maxAgeMs: number): T | null {
  try {
    const raw = fs.readFileSync(cachePath(key), "utf-8");
    const { fetchedAt, data } = JSON.parse(raw) as { fetchedAt: number; data: T };
    if (Date.now() - fetchedAt > maxAgeMs) return null;
    return data;
  } catch {
    return null;
  }
}

// Ignores maxAgeMs — returns whatever's on disk regardless of age, for use
// as a last-resort fallback when a live refetch fails (stale data beats none).
export function readDiskCacheStale<T>(key: string): T | null {
  try {
    const raw = fs.readFileSync(cachePath(key), "utf-8");
    const { data } = JSON.parse(raw) as { fetchedAt: number; data: T };
    return data;
  } catch {
    return null;
  }
}

export function writeDiskCache<T>(key: string, data: T): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath(key), JSON.stringify({ fetchedAt: Date.now(), data }), "utf-8");
  } catch (err) {
    console.error(`Failed to write disk cache for "${key}":`, err);
  }
}

export function clearDiskCache(key: string): void {
  try {
    fs.unlinkSync(cachePath(key));
  } catch {
    // already gone — fine
  }
}
