// Scoped to the cities actually in use: New York, SF Bay Area, and LA.
// Safe to import from client components — no server-only dependencies.
export const SUPPORTED_CITIES = [
  { value: "newyork", label: "New York City" },
  { value: "sfbay", label: "SF Bay Area" },
  { value: "losangeles", label: "Los Angeles" },
] as const;

// What city <select> dropdowns should actually offer.
export const VISIBLE_CITIES = SUPPORTED_CITIES.filter((c) => !("hidden" in c && c.hidden));
