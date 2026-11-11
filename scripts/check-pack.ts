import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Manifest = {
  version: string;
  peerDependencies?: Record<string, string>;
};

const run = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { stderr: "inherit" });
  if (r.exitCode !== 0)
    throw new Error(`${cmd.join(" ")} exited ${r.exitCode}`);
  return r.stdout.toString();
};

const tmp = mkdtempSync(join(tmpdir(), "heybe-pack-"));
const versions: Record<string, string> = {};

const check = (name: string) => {
  const dest = join(tmp, name.replace("/", "-"));
  run(["pnpm", "--filter", name, "pack", "--pack-destination", dest]);
  const tarball = join(
    dest,
    new Bun.Glob("*.tgz").scanSync(dest).next().value as string,
  );
  const entries = run(["tar", "-tzf", tarball]).split("\n").filter(Boolean);
  const manifestText = run(["tar", "-xzOf", tarball, "package/package.json"]);
  const manifest: Manifest = JSON.parse(manifestText);
  versions[name] = manifest.version;

  const required = ["package/LICENSE", "package/package.json"];
  const forbidden: RegExp[] = [];
  if (name === "heybe") {
    required.push(
      "package/src/cli.ts",
      "package/src/index.ts",
      "package/src/backups/vacuum-worker.ts",
      "package/ui/dist/index.html",
    );
    forbidden.push(
      /\.test\.ts$/,
      /^package\/(contract|bench|scripts)\//,
      /testdata/,
    );
  } else {
    required.push("package/dist/index.js", "package/dist/index.d.ts");
  }

  for (const file of required) {
    if (!entries.includes(file)) throw new Error(`${name}: missing ${file}`);
  }
  for (const pattern of forbidden) {
    const hit = entries.find((e) => pattern.test(e));
    if (hit) throw new Error(`${name}: unexpected ${hit}`);
  }
  if (manifestText.includes("workspace:")) {
    throw new Error(`${name}: packed package.json contains workspace:`);
  }
  if (name === "@heybe/client") {
    const expected = `^${versions["@heybe/query"]}`;
    const actual = manifest.peerDependencies?.["@heybe/query"];
    if (actual !== expected) {
      throw new Error(
        `${name}: @heybe/query peer is ${actual}, expected ${expected}`,
      );
    }
  }
  console.log(`OK ${name} (${entries.length} files)`);
};

try {
  for (const name of ["@heybe/query", "@heybe/client", "heybe"]) check(name);
} catch (err) {
  console.error(`FAIL ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
