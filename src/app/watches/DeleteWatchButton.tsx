"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function DeleteWatchButton({ watchId }: { watchId: string }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!confirm("Delete this saved search? This cannot be undone.")) return;
    setDeleting(true);
    await fetch(`/api/watches/${watchId}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <button
      onClick={handleDelete}
      disabled={deleting}
      className="text-red-600 hover:underline disabled:opacity-50"
    >
      {deleting ? "Deleting…" : "Delete"}
    </button>
  );
}
