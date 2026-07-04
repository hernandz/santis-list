import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AUTH_COOKIE_NAME, isValidAuthToken } from "@/lib/auth";

// Gates the whole app behind a single shared password, entered on a real
// /login page (not the browser's native Basic Auth prompt) — a signed cookie
// is set on success and checked here on every request. If APP_PASSWORD isn't
// set, auth is skipped entirely so a missing env var can't lock you out.
export function proxy(request: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (pathname === "/login" || pathname === "/api/login") return NextResponse.next();

  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  if (isValidAuthToken(token, password)) return NextResponse.next();

  // API calls are made via fetch(), which would otherwise silently follow a
  // redirect and hand the caller login-page HTML instead of JSON — a plain
  // 401 is what those callers already handle.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("from", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon|apple-icon).*)"],
};
