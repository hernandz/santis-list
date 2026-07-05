import { NextResponse } from "next/server";
import { isCrawlInProgress, getLastCrawlResult, getCrawlProgress } from "@/server/crawl/runCrawlCycle";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { inProgress: isCrawlInProgress(), lastResult: getLastCrawlResult(), progress: getCrawlProgress() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
