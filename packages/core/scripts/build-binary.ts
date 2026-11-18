import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import type { BunPlugin } from "bun";

const PKG = resolve(import.meta.dir, "..");
const UI_DIST = join(PKG, "ui/dist");

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => join(f.parentPath, f.name));
}

// embedded keys are URL-like paths, so Windows separators become "/"
const key = (from: string, file: string) =>
  relative(from, file).split(sep).join("/");

async function sharpNative(target: string) {
  const platform = target
    .replace(/^bun-/, "")
    .replace(/-(baseline|modern)$/, "")
    .replace(/^windows-/, "win32-");
  const sharpDir = dirname(Bun.resolveSync("sharp/package.json", PKG));
  const { version } = (await Bun.file(
    join(sharpDir, "package.json"),
  ).json()) as { version: string };
  const resolvePkg = (name: string, from: string) => {
    try {
      return dirname(Bun.resolveSync(`${name}/package.json`, from));
    } catch {
      throw new Error(
        `sharp native package ${name} is not installed; build on a ${platform} host`,
      );
    }
  };
  const addonDir = resolvePkg(`@img/sharp-${platform}`, sharpDir);
  const packages = [[`@img/sharp-${platform}`, addonDir]] as const;
  const libvips = platform.startsWith("win32-")
    ? []
    : ([
        [
          `@img/sharp-libvips-${platform}`,
          resolvePkg(`@img/sharp-libvips-${platform}`, addonDir),
        ],
      ] as const);
  const files = new Map<string, string>();
  for (const [name, dir] of [...packages, ...libvips])
    for (const file of filesUnder(join(dir, "lib")))
      files.set(`${name}/${key(dir, file)}`, file);
  const entry = [...files.keys()].find((k) => k.endsWith(".node"));
  if (!entry) throw new Error(`no .node file in @img/sharp-${platform}`);
  return { files, entry, version };
}

function embeddedModule(
  dashboard: Map<string, string>,
  sharp: Awaited<ReturnType<typeof sharpNative>>,
): string {
  const lines: string[] = [];
  const entries = (files: Map<string, string>) =>
    [...files].map(([key, path]) => {
      const name = `f${lines.length}`;
      lines.push(
        `import ${name} from ${JSON.stringify(path)} with { type: "file" };`,
      );
      return `[${JSON.stringify(key)}, ${name}]`;
    });
  const dash = entries(dashboard);
  const native = entries(sharp.files);
  return [
    ...lines,
    `export const DASHBOARD_FILES = new Map([${dash.join(", ")}]);`,
    `export const SHARP_NATIVE_FILES = new Map([${native.join(", ")}]);`,
    `export const SHARP_NATIVE_ENTRY = ${JSON.stringify(sharp.entry)};`,
    `export const SHARP_VERSION = ${JSON.stringify(sharp.version)};`,
  ].join("\n");
}

// a dlopen failure is cached with the module, so a dir removed under us gets one re-extract
const SHARP_MODULE = `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let sharp;
try {
  sharp = require(globalThis.__heybeSharpNative());
} catch {
  sharp = require(globalThis.__heybeSharpNative());
}
export default sharp;`;

export async function buildBinary(o: {
  target?: string;
  outfile?: string;
}): Promise<void> {
  const target =
    o.target ??
    `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const exe = target.startsWith("bun-windows-") ? "heybe.exe" : "heybe";
  const outfile = resolve(o.outfile ?? join(PKG, "dist", exe));
  const sharp = await sharpNative(target);

  const ui = Bun.spawnSync(["pnpm", "--filter", "@heybe/dashboard", "build"], {
    cwd: PKG,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!ui.success) throw new Error("dashboard build failed");
  const dashboard = new Map(
    filesUnder(UI_DIST).map((f) => [key(UI_DIST, f), f]),
  );

  const embedPlugin: BunPlugin = {
    name: "heybe-embedded",
    setup(b) {
      b.onLoad({ filter: /src[\\/]binary[\\/]embedded\.ts$/ }, () => ({
        contents: embeddedModule(dashboard, sharp),
        loader: "ts",
      }));
    },
  };
  const sharpPlugin: BunPlugin = {
    name: "heybe-sharp",
    setup(b) {
      b.onLoad({ filter: /sharp[\\/]dist[\\/]sharp\.mjs$/ }, () => ({
        contents: SHARP_MODULE,
        loader: "js",
      }));
    },
  };

  const result = await Bun.build({
    entrypoints: [
      join(PKG, "src/binary/entry.ts"),
      join(PKG, "src/binary/vacuum-worker.ts"),
      join(PKG, "src/binary/log-worker.ts"),
    ],
    compile: { target: target as Bun.Build.CompileTarget, outfile },
    minify: true,
    plugins: [embedPlugin, sharpPlugin],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("bun build failed");
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { target: { type: "string" }, outfile: { type: "string" } },
  });
  try {
    await buildBinary(values);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
