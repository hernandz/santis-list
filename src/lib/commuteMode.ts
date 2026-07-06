// Sensible default per city's actual transit character — LA is far more
// car-dependent than NYC/SF, which both have real heavy-rail systems. Shared
// between the client (listings feed default) and the server (notification
// emails), so both pick the same mode for the same city.
export function defaultCommuteModeForCity(city: string): "car" | "transit" {
  return city === "losangeles" ? "car" : "transit";
}

export function commuteModeEmoji(mode: "" | "car" | "bike" | "transit"): string {
  return mode === "car" ? "🚗" : mode === "bike" ? "🚴" : "🚆";
}
