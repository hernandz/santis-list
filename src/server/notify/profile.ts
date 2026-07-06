import { prisma } from "@/server/db/prisma";

// Resolves what a Watch's profileId should become given the transient
// alertName/alertEmail/removeAlerts fields on a watch create/update request
// (see watchSchema.ts) — never a stored column itself, just used to find-or-
// create the Profile those fields point at. Returns undefined to mean "don't
// touch profileId" (the common case: saving a search without touching its
// alert setup), null to explicitly clear it (removeAlerts), or a real id to
// attach/create a Profile for the given email.
export async function resolveProfileId(input: {
  alertName?: string;
  alertEmail?: string;
  removeAlerts?: boolean;
}): Promise<string | null | undefined> {
  if (input.removeAlerts) return null;
  if (!input.alertEmail) return undefined;

  const name = input.alertName?.trim() || input.alertEmail.split("@")[0];
  const profile = await prisma.profile.upsert({
    where: { email: input.alertEmail },
    update: { name },
    create: { email: input.alertEmail, name },
  });
  return profile.id;
}
