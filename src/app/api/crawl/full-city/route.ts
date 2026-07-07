import { NextResponse } from "next/server";
import { runFullCityCrawl } from "@/server/crawl/runCrawlCycle";

export const dynamic = "force-dynamic";

// Can take several minutes (every subarea of every supported city, no price
// filter) — normally only runs on its own weekly schedule (see
// scheduler.ts), this just lets it be forced on demand, e.g. to seed the
// Rent Map with data before its first scheduled run.
export async function POST() {
  try {
    const summary = await runFullCityCrawl();
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
