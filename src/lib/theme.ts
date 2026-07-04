export type Theme = "light" | "dark" | "auto";

const STORAGE_KEY = "theme";

export function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "auto";
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "auto";
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveEffectiveTheme(theme: Theme): "light" | "dark" {
  return theme === "auto" ? (systemPrefersDark() ? "dark" : "light") : theme;
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", resolveEffectiveTheme(theme));
  localStorage.setItem(STORAGE_KEY, theme);
}
