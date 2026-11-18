import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const LAYERS = ["state", "hooks", "primitives", "styled"];
const root = import.meta.dir;

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const IMPORT_SPEC =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["'](\.[^"']*)["']/g;

function layersImportedBy(file: string, source: string): string[] {
  const found = new Set<string>();
  for (const [, spec] of source.matchAll(IMPORT_SPEC)) {
    const target = join(file, "..", spec!)
      .slice(root.length + 1)
      .split("/")[0]!;
    if (LAYERS.includes(target)) found.add(target);
  }
  return [...found];
}

function importedLayers(layer: string): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(join(root, layer))) {
    for (const l of layersImportedBy(file, readFileSync(file, "utf8")))
      found.add(l);
  }
  return [...found];
}

function expectOnly(layer: string, allowed: string[]) {
  const forbidden = importedLayers(layer).filter(
    (l) => l !== layer && !allowed.includes(l),
  );
  expect(forbidden).toEqual([]);
}

describe("layer rules", () => {
  test("state imports nothing from hooks, primitives or styled", () => {
    expectOnly("state", []);
  });
  test("hooks import only state", () => {
    expectOnly("hooks", ["state"]);
  });
  test("primitives import only state and hooks", () => {
    expectOnly("primitives", ["state", "hooks"]);
  });
});

describe("import detection", () => {
  test("finds named, side-effect, re-export and dynamic imports", () => {
    const file = join(root, "state", "a.ts");
    const source = [
      'import { x } from "../hooks/x.js";',
      'import "../primitives/y.js";',
      'export * from "../styled/z.js";',
      'const m = await import("../hooks/w.js");',
      'import { ok } from "./local.js";',
    ].join("\n");
    expect(layersImportedBy(file, source).sort()).toEqual([
      "hooks",
      "primitives",
      "state",
      "styled",
    ]);
  });
});
