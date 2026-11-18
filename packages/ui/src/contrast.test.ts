import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "theme.css"), "utf8");

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  return start < 0 ? "" : css.slice(start, css.indexOf("}", start));
}

function tokens(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of block(selector).matchAll(
    /(--hb-[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g,
  )) {
    out[name] = value;
  }
  return out;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const pairs: [string, string, number][] = [
  ["--hb-text", "--hb-bg", 4.5],
  ["--hb-text", "--hb-surface", 4.5],
  ["--hb-text-muted", "--hb-surface", 4.5],
  ["--hb-accent-fg", "--hb-accent", 4.5],
  ["--hb-danger-fg", "--hb-danger", 4.5],
  ["--hb-accent-fg", "--hb-accent-hover", 4.5],
  ["--hb-danger-fg", "--hb-danger-hover", 4.5],
  ["--hb-accent-text", "--hb-surface", 4.5],
  ["--hb-focus", "--hb-surface", 3],
  ["--hb-danger-text", "--hb-surface", 4.5],
  ["--hb-danger-text", "--hb-surface-raised", 4.5],
  ["--hb-danger-text", "--hb-bg", 4.5],
  ["--hb-text-faint", "--hb-surface", 4.5],
  ["--hb-text-faint", "--hb-surface-raised", 4.5],
  ["--hb-text-faint", "--hb-bg", 4.5],
  ["--hb-control", "--hb-surface", 3],
  ["--hb-control", "--hb-surface-raised", 3],
  ["--hb-control", "--hb-bg", 3],
  ["--hb-thumb", "--hb-control", 3],
  ["--hb-accent", "--hb-surface", 3],
  ["--hb-warning-text", "--hb-warning-bg", 4.5],
  ["--hb-warning-line", "--hb-warning-bg", 1.2],
];

describe.each([
  ["light", ":root"],
  ["dark", ':root[data-theme="dark"]'],
])("%s theme contrast", (_name, selector) => {
  const theme = { ...tokens(":root"), ...tokens(selector) };
  test.each(pairs)("%s on %s >= %f", (fg, bg, min) => {
    expect(theme[fg]).toBeDefined();
    expect(theme[bg]).toBeDefined();
    expect(ratio(theme[fg]!, theme[bg]!)).toBeGreaterThanOrEqual(min);
  });

  test.each(["--hb-surface", "--hb-field-bg"])(
    "--hb-field-line on %s >= 3",
    (bg) => {
      expect(
        ratio(theme["--hb-field-line"]!, theme[bg]!),
      ).toBeGreaterThanOrEqual(3);
    },
  );

  test.each(["--hb-surface", "--hb-bg"])(
    "--hb-text-muted on neutral badge tint over %s >= 4.5",
    (bg) => {
      expect(
        ratio(
          theme["--hb-text-muted"]!,
          tint(theme["--hb-text"]!, theme[bg]!, 0.06),
        ),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );

  test("--hb-field-bg differs from --hb-surface", () => {
    expect(
      ratio(theme["--hb-field-bg"]!, theme["--hb-surface"]!),
    ).toBeGreaterThan(1.02);
  });

  test.each(["--hb-surface", "--hb-bg"])(
    "--hb-success-text on 15%% success tint over %s >= 4.5",
    (bg) => {
      expect(
        ratio(
          theme["--hb-success-text"]!,
          tint(theme["--hb-success"]!, theme[bg]!, 0.15),
        ),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );

  test.each(["--hb-surface", "--hb-bg"])(
    "--hb-danger-text on 15%% danger tint over %s >= 4.5",
    (bg) => {
      expect(
        ratio(
          theme["--hb-danger-text"]!,
          tint(theme["--hb-danger"]!, theme[bg]!, 0.15),
        ),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );
});

function tint(fg: string, bg: string, alpha: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5]
    .map((i) =>
      Math.round(channel(fg, i) * alpha + channel(bg, i) * (1 - alpha))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
