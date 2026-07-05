"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function PauseToggleButton({ watchId, isActive }: { watchId: string; isActive: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleToggle() {
    setPending(true);
    await fetch(`/api/watches/${watchId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !isActive }),
    });
    setPending(false);
    router.refresh();
  }

  return (
    <button onClick={handleToggle} disabled={pending} className="hover:underline disabled:opacity-50">
      {pending ? (isActive ? "Pausing…" : "Resuming…") : isActive ? "Pause" : "Resume"}
    </button>
  );
}
