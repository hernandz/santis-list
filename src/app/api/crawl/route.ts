import { NextResponse } from "next/server";
import { runCrawlCycle } from "@/server/crawl/runCrawlCycle";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const summary = await runCrawlCycle();
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
