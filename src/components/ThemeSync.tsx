"use client";

import { useEffect } from "react";
import { applyTheme, getStoredTheme } from "@/lib/theme";

// Keeps "auto" mode actually live: if the OS preference changes while the
// tab is open and the user hasn't overridden to light/dark, re-apply so the
// page follows along instead of only updating on next reload.
export function ThemeSync() {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    function handleChange() {
      if (getStoredTheme() === "auto") applyTheme("auto");
    }
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  return null;
}
