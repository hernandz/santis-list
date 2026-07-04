"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get("from") || "/";

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    setSubmitting(false);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong");
      return;
    }

    router.push(from);
    router.refresh();
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 w-full max-w-xs">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-1.5">
            <span aria-hidden>🍉</span> santi&apos;s list
          </h1>
          <p className="text-sm text-black/60 dark:text-white/60">Enter the password to continue.</p>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <input
          type="password"
          autoFocus
          placeholder="Password"
          className="border rounded px-3 py-2 border-black/15 dark:border-white/20 bg-transparent"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <button
          type="submit"
          disabled={submitting || !password}
          className="px-4 py-2 rounded bg-foreground text-background disabled:opacity-50"
        >
          {submitting ? "Checking…" : "Continue"}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
