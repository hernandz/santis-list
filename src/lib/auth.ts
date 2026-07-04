import { createHash } from "node:crypto";

export const AUTH_COOKIE_NAME = "app_auth";

// The cookie stores a hash of the password rather than the password itself,
// so the raw value never sits in the browser's cookie store.
export function hashPassword(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

export function isValidAuthToken(token: string | undefined, password: string): boolean {
  return Boolean(token) && token === hashPassword(password);
}
