import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const tarballs: Record<string, string> = {};

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
  tarballs[name] = tarball;

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
  if (name === "@heybe/ui") {
    required.push("package/dist/style.css", "package/src/theme.css");
    forbidden.push(/\.test\./);
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
  if (name === "@heybe/ui") {
    for (const dep of ["react", "react-dom"]) {
      if (!manifest.peerDependencies?.[dep]) {
        throw new Error(`${name}: missing ${dep} peer dependency`);
      }
    }
  }
  console.log(`OK ${name} (${entries.length} files)`);
};

const waitFor = async (probe: () => Promise<boolean>, maxMs: number) => {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await probe().catch(() => false)) return;
    await Bun.sleep(50);
  }
  throw new Error(`condition not met within ${maxMs} ms`);
};

const smokeInstalled = async () => {
  const dir = join(tmp, "install");
  mkdirSync(dir);
  const query = `file:${tarballs["@heybe/query"]}`;
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "heybe-pack-smoke",
      private: true,
      dependencies: { heybe: `file:${tarballs.heybe}`, "@heybe/query": query },
      overrides: { "@heybe/query": query },
    }),
  );
  run(["bun", "install", "--cwd", dir]);
  const bin = join(dir, "node_modules", ".bin", "heybe");

  if (!run([bin, "--help"]).includes("Usage:")) {
    throw new Error("installed heybe --help has no Usage:");
  }

  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  const proc = Bun.spawn(
    [bin, "serve", "--http", `127.0.0.1:${port}`, "--dir", join(dir, "data")],
    { cwd: dir, stdout: "ignore", stderr: "inherit" },
  );
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 10000);
    const ui = await fetch(`${base}/_/`);
    if (!ui.ok || !(await ui.text()).includes("<html")) {
      throw new Error("installed heybe does not serve the dashboard at /_/");
    }
  } finally {
    proc.kill("SIGTERM");
    await Promise.race([
      proc.exited,
      Bun.sleep(5000).then(() => proc.kill("SIGKILL")),
    ]);
  }
  console.log("OK installed heybe serves /api/health and /_/");
};

try {
  for (const name of ["@heybe/query", "@heybe/client", "@heybe/ui", "heybe"])
    check(name);
  await smokeInstalled();
} catch (err) {
  console.error(`FAIL ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
