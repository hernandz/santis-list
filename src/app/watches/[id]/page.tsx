import { notFound } from "next/navigation";
import { prisma } from "@/server/db/prisma";
import { WatchForm } from "../WatchForm";

export const dynamic = "force-dynamic";

export default async function EditWatchPage(props: PageProps<"/watches/[id]">) {
  const { id } = await props.params;
  const watch = await prisma.watch.findUnique({ where: { id }, include: { profile: true } });
  if (!watch) notFound();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Edit saved search</h1>
      <WatchForm
        watchId={watch.id}
        initialValues={{
          name: watch.name,
          city: watch.city,
          subareas: watch.subareas,
          neighborhoods: watch.neighborhoods,
          keyword: watch.keyword ?? "",
          minPrice: watch.minPrice?.toString() ?? "",
          maxPrice: watch.maxPrice?.toString() ?? "",
          minBedrooms: watch.minBedrooms?.toString() ?? "",
          minBathrooms: watch.minBathrooms?.toString() ?? "",
          notifyFrequency: watch.notifyFrequency,
          isActive: watch.isActive,
          alertsEnabled: watch.profile != null,
          alertName: watch.profile?.name ?? "",
          alertEmail: watch.profile?.email ?? "",
        }}
      />
    </div>
  );
}
