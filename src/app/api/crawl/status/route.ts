import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import { isCrawlInProgress, getLastCrawlResult, getCrawlProgress } from "@/server/crawl/runCrawlCycle";

export const dynamic = "force-dynamic";

export async function GET() {
  // lastResult only lives in memory (see runCrawlCycle.ts) and resets to null
  // on every server restart, even though crawling has continued for days —
  // this is derived straight from the data instead, so "how fresh is this"
  // survives restarts and doesn't require its own persisted crawl-log table.
  const { _max } = await prisma.listing.aggregate({ _max: { firstSeenAt: true } });

  return NextResponse.json(
    {
      inProgress: isCrawlInProgress(),
      lastResult: getLastCrawlResult(),
      progress: getCrawlProgress(),
      mostRecentListingSeenAt: _max.firstSeenAt,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
