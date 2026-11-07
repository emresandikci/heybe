import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PB_VERSION = "0.41.1";
const SUPERUSER_EMAIL = "test@example.com";
const SUPERUSER_PASSWORD = "1234567890";
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CLI = resolve(import.meta.dir, "../src/cli.ts");
const KEPT_HEADERS = /^(content-type|access-control-.*)$/;
const PLACEHOLDER_KEYS: Record<string, string> = {
  token: "<token>",
  created: "<created>",
  updated: "<updated>",
  tokenKey: "<tokenKey>",
};

export interface Target {
  name: "pocketbase" | "heybe";
  url: string;
  superToken: string;
}

export interface Snapshot {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

interface Started {
  pb: Target;
  hb: Target;
  stop(): Promise<void>;
}

let active: Started | null = null;
let idMaps = new Map<Target["name"], Map<string, string>>();

async function pocketbaseBinary(): Promise<string> {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const bin = join(REPO_ROOT, ".cache/pocketbase", PB_VERSION, "pocketbase");
  if (existsSync(bin)) return bin;

  const dir = join(REPO_ROOT, ".cache/pocketbase", PB_VERSION);
  await mkdir(dir, { recursive: true });
  const url = `https://ganigeorgiev.com/meta/pocketbase/pocketbase/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_${os}_${arch}.zip`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PocketBase download failed: ${res.status}`);
  const zip = join(dir, "pocketbase.zip");
  await Bun.write(zip, res);
  const unzip = Bun.spawn(["unzip", "-o", "-q", zip, "pocketbase", "-d", dir]);
  if ((await unzip.exited) !== 0) throw new Error("PocketBase unzip failed");
  await rm(zip);
  await chmod(bin, 0o755);
  return bin;
}

async function freePort(): Promise<number> {
  const probe = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const { port } = probe;
  probe.stop(true);
  return port;
}

async function waitHealthy(url: string, name: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error(`${name} did not become healthy at ${url}`);
}

async function runOk(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed: ${err}`);
}

async function startOne(
  name: Target["name"],
  command: string[],
  extraFlags: (dir: string) => string[] = () => [],
): Promise<{ target: Target; stop(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), `heybe-contract-${name}-`));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  await runOk([
    ...command,
    "superuser",
    "upsert",
    SUPERUSER_EMAIL,
    SUPERUSER_PASSWORD,
    "--dir",
    dir,
    ...extraFlags(dir),
  ]);
  const proc = Bun.spawn(
    [
      ...command,
      "serve",
      "--http",
      `127.0.0.1:${port}`,
      "--dir",
      dir,
      ...extraFlags(dir),
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  const stop = async () => {
    proc.kill();
    await proc.exited;
    await rm(dir, { recursive: true, force: true });
  };
  try {
    await waitHealthy(url, name);
  } catch (err) {
    await stop();
    throw err;
  }
  let superToken = "";
  try {
    const res = await fetch(
      `${url}/api/collections/_superusers/auth-with-password`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          identity: SUPERUSER_EMAIL,
          password: SUPERUSER_PASSWORD,
        }),
      },
    );
    if (!res.ok)
      throw new Error(`${name} superuser login failed: ${res.status}`);
    superToken = ((await res.json()) as { token: string }).token;
  } catch (err) {
    await stop();
    throw err;
  }
  return { target: { name, url, superToken }, stop };
}

export async function startTargets(): Promise<Started> {
  const pbBin = await pocketbaseBinary();
  const pb = await startOne("pocketbase", [pbBin], (dir) => [
    "--migrationsDir",
    join(dir, "pb_migrations"),
    "--hooksDir",
    join(dir, "pb_hooks"),
  ]);
  let hb: Awaited<ReturnType<typeof startOne>>;
  try {
    hb = await startOne("heybe", ["bun", CLI]);
  } catch (err) {
    await pb.stop();
    throw err;
  }
  idMaps = new Map();
  active = {
    pb: pb.target,
    hb: hb.target,
    stop: async () => {
      await Promise.all([pb.stop(), hb.stop()]);
      active = null;
    },
  };
  return active;
}

function normalize(target: Target["name"], value: unknown, key = ""): unknown {
  const ids = idMaps.get(target) ?? new Map<string, string>();
  idMaps.set(target, ids);
  const placeholder = (v: string) => {
    if (!ids.has(v)) ids.set(v, `<id:${ids.size + 1}>`);
    return ids.get(v);
  };
  if (Array.isArray(value)) return value.map((v) => normalize(target, v, key));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(target, v, k)]),
    );
  }
  if (typeof value === "string") {
    if (key === "id" && value !== "") return placeholder(value);
    if (Object.hasOwn(PLACEHOLDER_KEYS, key)) return PLACEHOLDER_KEYS[key];
    // other strings only when already seen as an id (relation values), so a wrong value is not hidden
    if (value !== "" && ids.has(value)) return placeholder(value);
  }
  return value;
}

async function snapshot(target: Target, res: Response): Promise<Snapshot> {
  const headers: Record<string, string> = {};
  for (const [k, v] of res.headers) if (KEPT_HEADERS.test(k)) headers[k] = v;
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return {
    status: res.status,
    headers,
    body: normalize(target.name, body),
  };
}

export async function both(
  fn: (t: Target) => Promise<Response>,
): Promise<[Snapshot, Snapshot]> {
  if (!active) throw new Error("startTargets() was not called");
  const { pb, hb } = active;
  return Promise.all([
    fn(pb).then((r) => snapshot(pb, r)),
    fn(hb).then((r) => snapshot(hb, r)),
  ]);
}

export function expectSame(a: Snapshot, b: Snapshot): void {
  expect(b).toEqual(a);
}
