import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Gates the whole app behind a single shared password (HTTP Basic Auth —
// any username works, only the password is checked). If APP_PASSWORD isn't
// set, auth is skipped entirely so a missing env var can't lock you out.
export function proxy(request: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();

  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf-8");
    const suppliedPassword = decoded.slice(decoded.indexOf(":") + 1);
    if (suppliedPassword === password) return NextResponse.next();
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="santi\'s list"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon|apple-icon).*)"],
};
