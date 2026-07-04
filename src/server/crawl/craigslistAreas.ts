// Craigslist's sub-area codes aren't listed anywhere in the (JS-driven) search
// UI's no-js fallback markup, so unlike neighborhood names/locations they can't
// be discovered by scraping a live page. They're also a small, essentially
// fixed enumeration Craigslist itself defines per metro (much like the city
// subdomain list in lib/craigslistCities.ts). Verified live 2026-07-03 by
// requesting https://www.craigslist.org/search/subarea/{code}?cat=apa for each
// candidate and confirming a non-empty, genuinely distinct result set (e.g.
// zero URL overlap between sfc and eby).
const SUBAREAS: Record<string, { code: string; label: string }[]> = {
  newyork: [
    { code: "mnh", label: "Manhattan" },
    { code: "brk", label: "Brooklyn" },
    { code: "que", label: "Queens" },
    { code: "brx", label: "Bronx" },
    { code: "stn", label: "Staten Island" },
    { code: "jsy", label: "Jersey City area" },
    { code: "wch", label: "Westchester County" },
    { code: "lgi", label: "Long Island" },
  ],
  sfbay: [
    { code: "sfc", label: "San Francisco" },
    { code: "eby", label: "East Bay" },
    { code: "pen", label: "Peninsula" },
    { code: "sby", label: "South Bay" },
    { code: "nby", label: "North Bay" },
    { code: "scz", label: "Santa Cruz" },
  ],
  losangeles: [
    { code: "lac", label: "Central LA" },
    { code: "sfv", label: "San Fernando Valley" },
    { code: "wst", label: "Westside" },
    { code: "sgv", label: "San Gabriel Valley" },
    { code: "ant", label: "Antelope Valley" },
    { code: "lgb", label: "Long Beach" },
  ],
};

export function getCraigslistAreas(city: string): { code: string; label: string }[] {
  return SUBAREAS[city] ?? [];
}
