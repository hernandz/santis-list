import { NextResponse } from "next/server";
import { getAllLines } from "@/server/geo/transitStations";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const city = searchParams.get("city")?.trim();
  if (!city) {
    return NextResponse.json({ error: "city query param is required" }, { status: 400 });
  }

  try {
    const lines = await getAllLines(city);
    return NextResponse.json({ lines }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
