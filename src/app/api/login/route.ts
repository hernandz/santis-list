import { NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, hashPassword } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    return NextResponse.json({ error: "No password configured" }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const supplied = typeof body.password === "string" ? body.password : "";

  if (supplied !== password) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE_NAME, hashPassword(password), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
