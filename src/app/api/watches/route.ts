import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import { watchInputSchema } from "@/lib/watchSchema";
import { resolveProfileId } from "@/server/notify/profile";

export const dynamic = "force-dynamic";

export async function GET() {
  const watches = await prisma.watch.findMany({ include: { profile: true }, orderBy: { createdAt: "desc" } });
  return NextResponse.json(watches, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = watchInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { alertName, alertEmail, removeAlerts, ...watchFields } = parsed.data;
  const profileId = await resolveProfileId({ alertName, alertEmail, removeAlerts });

  const watch = await prisma.watch.create({ data: { ...watchFields, profileId: profileId ?? null } });
  return NextResponse.json(watch, { status: 201 });
}
