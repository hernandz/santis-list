import { prisma } from "@/server/db/prisma";
import { isValidPauseToken } from "@/lib/pauseToken";

export const dynamic = "force-dynamic";

// Deliberately not behind the app's password gate (see src/proxy.ts) — this
// is meant to be clicked directly from an email client with no session.
// The per-watch token (not the site password) is what authorizes it, and it
// can only ever pause that one watch, nothing else.
function htmlResponse(body: string, status = 200): Response {
  return new Response(`<!doctype html><html><body style="font-family: sans-serif; padding: 2rem;">${body}</body></html>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function GET(request: Request, ctx: RouteContext<"/api/watches/[id]/pause">) {
  const { id } = await ctx.params;
  const token = new URL(request.url).searchParams.get("token") ?? "";

  if (!isValidPauseToken(id, token)) {
    return htmlResponse("<p>This pause link is invalid or has expired.</p>", 403);
  }

  const watch = await prisma.watch.findUnique({ where: { id } });
  if (!watch) {
    return htmlResponse("<p>That saved search no longer exists.</p>", 404);
  }

  await prisma.watch.update({ where: { id }, data: { isActive: false } });

  return htmlResponse(
    `<p><strong>"${watch.name}"</strong> is now paused — it won't be crawled or send any more alerts.</p>` +
      `<p>You can turn it back on any time from Saved Searches.</p>`,
  );
}
