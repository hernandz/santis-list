import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import { settingsInputSchema } from "@/lib/settingsSchema";
import { geocodeAddress } from "@/server/geo/geocode";

export const dynamic = "force-dynamic";

const SETTINGS_ID = "singleton";

export async function GET() {
  const settings = await prisma.settings.findUnique({ where: { id: SETTINGS_ID } });
  return NextResponse.json(
    settings ?? {
      id: SETTINGS_ID,
      workAddress: null,
      workLatitude: null,
      workLongitude: null,
      useGoogleDirections: false,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(request: Request) {
  const body = await request.json();
  const parsed = settingsInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { workAddress, useGoogleDirections, confirmPassword } = parsed.data;

  const existing = await prisma.settings.findUnique({ where: { id: SETTINGS_ID } });

  // Turning Google Directions ON costs real money past the free tier, so it
  // requires re-entering the app password — not just an already-open session
  // — as a deliberate extra confirmation step, distinct from every other
  // setting here. Turning it OFF (or leaving it unchanged) never needs this.
  const turningOn = useGoogleDirections === true && existing?.useGoogleDirections !== true;
  if (turningOn) {
    const appPassword = process.env.APP_PASSWORD;
    if (!appPassword || confirmPassword !== appPassword) {
      return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
    }
  }

  let workLatitude = existing?.workLatitude ?? null;
  let workLongitude = existing?.workLongitude ?? null;

  // Only re-geocode when the address text actually changed — Nominatim's
  // usage policy is 1 req/sec and there's no reason to re-hit it on every
  // unrelated settings save (e.g. just flipping useGoogleDirections).
  if (workAddress !== (existing?.workAddress ?? null)) {
    if (workAddress) {
      try {
        const geocoded = await geocodeAddress(workAddress);
        if (!geocoded) {
          return NextResponse.json({ error: "Could not find that address" }, { status: 422 });
        }
        workLatitude = geocoded.latitude;
        workLongitude = geocoded.longitude;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: message }, { status: 502 });
      }
    } else {
      workLatitude = null;
      workLongitude = null;
    }
  }

  const settings = await prisma.settings.upsert({
    where: { id: SETTINGS_ID },
    create: {
      id: SETTINGS_ID,
      workAddress,
      workLatitude,
      workLongitude,
      useGoogleDirections: useGoogleDirections ?? false,
    },
    update: {
      workAddress,
      workLatitude,
      workLongitude,
      ...(useGoogleDirections !== undefined ? { useGoogleDirections } : {}),
    },
  });

  return NextResponse.json(settings);
}
