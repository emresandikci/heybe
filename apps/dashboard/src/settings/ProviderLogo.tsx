import type { CSSProperties } from "react";
import { PROVIDER_ICONS } from "./provider-icons";

const LIGHT_SURFACE = "#ffffff";
const DARK_SURFACE = "#121216";

function luminance(hex: string): number {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

export function ProviderLogo({
  name,
  displayName,
}: {
  name: string;
  displayName: string;
}) {
  const icon = PROVIDER_ICONS[name];
  const tile =
    "flex size-8 shrink-0 items-center justify-center rounded-control bg-hover";
  if (!icon)
    return (
      <span
        data-testid="monogram"
        aria-hidden="true"
        className={`${tile} text-sm font-semibold text-text`}
      >
        {displayName.charAt(0).toUpperCase()}
      </span>
    );
  if ("shapes" in icon)
    return (
      <span aria-hidden="true" className={tile}>
        <svg viewBox={icon.viewBox} className="size-[18px]">
          {icon.shapes.map((shape) => (
            <path
              key={shape.d}
              d={shape.d}
              fill={shape.fill}
              fillRule={shape.fillRule}
            />
          ))}
        </svg>
      </span>
    );
  const light = contrast(icon.hex, LIGHT_SURFACE) >= 3;
  const dark = contrast(icon.hex, DARK_SURFACE) >= 3;
  return (
    <span
      aria-hidden="true"
      className={`${tile} ${light ? "text-[var(--brand)]" : "text-text"} ${dark ? "dark:text-[var(--brand)]" : "dark:text-text"}`}
      style={{ "--brand": `#${icon.hex}` } as CSSProperties}
    >
      <svg viewBox="0 0 24 24" className="size-[18px]" fill="currentColor">
        <path d={icon.path} />
      </svg>
    </span>
  );
}
