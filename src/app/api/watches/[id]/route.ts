import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import { watchUpdateSchema } from "@/lib/watchSchema";
import { resolveProfileId } from "@/server/notify/profile";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: RouteContext<"/api/watches/[id]">) {
  const { id } = await ctx.params;
  const watch = await prisma.watch.findUnique({ where: { id }, include: { profile: true } });
  if (!watch) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(watch, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/watches/[id]">) {
  const { id } = await ctx.params;
  const body = await request.json();
  const parsed = watchUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { alertName, alertEmail, removeAlerts, ...watchFields } = parsed.data;
  const profileId = await resolveProfileId({ alertName, alertEmail, removeAlerts });

  const watch = await prisma.watch.update({
    where: { id },
    data: { ...watchFields, ...(profileId !== undefined ? { profileId } : {}) },
  });
  return NextResponse.json(watch);
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/watches/[id]">) {
  const { id } = await ctx.params;
  await prisma.watch.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
