import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";

export const dynamic = "force-dynamic";

// Total crawled listings per city — used by the map page to default to
// whichever city actually has the most data, rather than always opening on
// a hardcoded one that might have nothing crawled for it yet.
export async function GET() {
  const grouped = await prisma.listing.groupBy({ by: ["city"], _count: { _all: true } });
  const counts: Record<string, number> = {};
  for (const row of grouped) counts[row.city] = row._count._all;

  return NextResponse.json({ counts }, { headers: { "Cache-Control": "no-store" } });
}
