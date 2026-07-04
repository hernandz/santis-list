import { NextResponse } from "next/server";
import { getNeighborhoodNames } from "@/server/geo/neighborhoodBoundaries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const city = searchParams.get("city")?.trim();
  if (!city) {
    return NextResponse.json({ error: "city query param is required" }, { status: 400 });
  }

  const regions = searchParams.getAll("region").filter(Boolean);

  try {
    const neighborhoods = await getNeighborhoodNames(city, regions.length > 0 ? regions : undefined);
    return NextResponse.json({ neighborhoods }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
