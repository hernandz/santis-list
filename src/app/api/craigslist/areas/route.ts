import { NextResponse } from "next/server";
import { getCraigslistAreas } from "@/server/crawl/craigslistAreas";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const city = searchParams.get("city")?.trim();
  if (!city) {
    return NextResponse.json({ error: "city query param is required" }, { status: 400 });
  }

  return NextResponse.json({ areas: getCraigslistAreas(city) }, { headers: { "Cache-Control": "no-store" } });
}
