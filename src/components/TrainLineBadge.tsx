"use client";

export type TransitLine = { name: string; color: string; system?: string };

function abbreviate(name: string): string {
  const metroMatch = name.match(/^Metro (\w+) Line$/i);
  if (metroMatch) return metroMatch[1];
  // "VTA Blue"/"VTA Green"/"VTA Orange" are prefixed with the operator name
  // to stay distinct from BART's similarly-named lines in a flat list — but
  // that means they'd otherwise all abbreviate down to the same "V".
  const vtaMatch = name.match(/^VTA (\w+)$/i);
  if (vtaMatch) return vtaMatch[1].slice(0, 1).toUpperCase();
  if (name.length <= 3) return name;
  return name.slice(0, 1).toUpperCase();
}

function textColorFor(hex: string): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return "#000000";
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#000000" : "#FFFFFF";
}

export function TrainLineBadge({ line }: { line: TransitLine }) {
  return (
    <span
      title={line.name}
      style={{ backgroundColor: line.color, color: textColorFor(line.color) }}
      className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold shrink-0 leading-none"
    >
      {abbreviate(line.name)}
    </span>
  );
}
