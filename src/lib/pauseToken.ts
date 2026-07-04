import { createHmac } from "node:crypto";

// No extra setup required: falls back to DATABASE_URL (always set, unique
// per deployment) if PAUSE_LINK_SECRET isn't configured. Either way, this is
// derived rather than stored, so pausing a watch from an emailed link needs
// no new database column.
function secret(): string {
  return process.env.PAUSE_LINK_SECRET || process.env.DATABASE_URL || "insecure-fallback-secret";
}

export function generatePauseToken(watchId: string): string {
  return createHmac("sha256", secret()).update(watchId).digest("hex").slice(0, 32);
}

export function isValidPauseToken(watchId: string, token: string): boolean {
  return token === generatePauseToken(watchId);
}

// APP_URL is the deployed origin (e.g. https://your-app.up.railway.app) —
// needed because notifications are sent from a cron tick, not in response to
// an HTTP request, so there's no request URL to build an absolute link from.
export function buildPauseUrl(watchId: string): string | null {
  const appUrl = process.env.APP_URL;
  if (!appUrl) return null;
  return `${appUrl.replace(/\/$/, "")}/api/watches/${watchId}/pause?token=${generatePauseToken(watchId)}`;
}
