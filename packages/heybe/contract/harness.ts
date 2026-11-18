import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const PB_VERSION = "0.41.1";
const PB_SHA256 = {
  darwin_arm64:
    "e07ff212b7a7ab53c70d47b11d48ac7d011b4961b6eccbcd231bffe7a54173a0",
  darwin_amd64:
    "290fba606621ea2edcf777f32a66c7f065bac2cb2175a1556713884bc951988c",
  linux_amd64:
    "7504ec99a85fe405fc9941b4d94bdea20733b53707c8251b66fd0daa1444347e",
  linux_arm64:
    "341a249f97f4ff1ba8dfff81d357eb281cd346fbddae8b6ea43193f0647e036d",
};
export const SUPERUSER_EMAIL = "test@example.com";
export const SUPERUSER_PASSWORD = "1234567890";
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CLI = resolve(import.meta.dir, "../src/cli.ts");
const KEPT_HEADERS = /^(content-type|access-control-.*)$/;
const DATE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// Only values in the expected format are replaced, so an empty or malformed value still shows as a difference.
const PLACEHOLDERS: Record<string, [RegExp, string]> = {
  otpId: [/^[a-z0-9]{15}$/, "<otpId>"],
  mfaId: [/^[a-z0-9]{15}$/, "<mfaId>"],
  token: [/^[\w-]+\.[\w-]+\.[\w-]+$/, "<token>"],
  created: [DATE, "<created>"],
  updated: [DATE, "<updated>"],
  tokenKey: [/./, "<tokenKey>"],
  expiry: [DATE, "<expiry>"],
};

export interface Target {
  name: "pocketbase" | "heybe";
  url: string;
  superToken: string;
  dir: string;
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

export async function verifySha256(
  file: string,
  expected: string,
): Promise<void> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(file).arrayBuffer());
  if (hasher.digest("hex") !== expected)
    throw new Error(`PocketBase download checksum mismatch: ${basename(file)}`);
}

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
  try {
    await verifySha256(
      zip,
      PB_SHA256[`${os}_${arch}` as keyof typeof PB_SHA256],
    );
  } catch (err) {
    await rm(zip);
    throw err;
  }
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
  existingDir?: string,
): Promise<{ target: Target; stop(): Promise<void> }> {
  const dir =
    existingDir ?? (await mkdtemp(join(tmpdir(), `heybe-contract-${name}-`)));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  if (!existingDir || name === "pocketbase")
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
    if (!existingDir) await rm(dir, { recursive: true, force: true });
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
  return { target: { name, url, superToken, dir }, stop };
}

const pbFlags = (dir: string) => [
  "--migrationsDir",
  join(dir, "pb_migrations"),
  "--hooksDir",
  join(dir, "pb_hooks"),
];

// runs on an existing data dir and leaves it in place on stop
export async function startPocketBase(
  dataDir: string,
): Promise<Target & { stop(): Promise<void> }> {
  const { target, stop } = await startOne(
    "pocketbase",
    [await pocketbaseBinary()],
    pbFlags,
    dataDir,
  );
  return { ...target, stop };
}

export async function startHeybe(
  dataDir: string,
): Promise<Target & { stop(): Promise<void> }> {
  const { target, stop } = await startOne(
    "heybe",
    ["bun", CLI],
    (dir) => ["--migrationsDir", join(dir, "heybe_migrations")],
    dataDir,
  );
  return { ...target, stop };
}

export async function startTargets(
  opts: { heybeEntry?: string; pbHooksDir?: string } = {},
): Promise<Started> {
  const pbBin = await pocketbaseBinary();
  const pb = await startOne("pocketbase", [pbBin], (dir) => [
    "--migrationsDir",
    join(dir, "pb_migrations"),
    "--hooksDir",
    opts.pbHooksDir ?? join(dir, "pb_hooks"),
  ]);
  let hb: Awaited<ReturnType<typeof startOne>>;
  try {
    hb = await startOne("heybe", ["bun", opts.heybeEntry ?? CLI], (dir) => [
      "--migrationsDir",
      join(dir, "heybe_migrations"),
    ]);
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

// Heybe uses hb where PocketBase uses pb: pbc_<n> ids, _pb_users_auth_, __pbDBOptimize__ cron ids.
// Takes an id or a path with one.
export const own = (t: Target, pbIdOrPath: string) =>
  t.name === "heybe"
    ? pbIdOrPath.replace(/(^|\/)(_*)pb(?=c_|_|[A-Z])/g, "$1$2hb")
    : pbIdOrPath;

// a JSON request body with the users collection id in the target's form
export const ownBody = (t: Target, json: string) =>
  t.name === "heybe"
    ? json.replaceAll('"_pb_users_auth_"', '"_hb_users_auth_"')
    : json;

const HB_PREFIX = /hbc_|_hb_|__hb/g;

export function normalize(
  target: Target["name"],
  value: unknown,
  key = "",
): unknown {
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
    const s =
      target === "heybe"
        ? value.replace(HB_PREFIX, (m) => m.replace("hb", "pb"))
        : value;
    if (key === "id" && s !== "") return placeholder(s);
    if (Object.hasOwn(PLACEHOLDERS, key)) {
      const [format, placeholder] = PLACEHOLDERS[key]!;
      if (format.test(s)) return placeholder;
    }
    // other strings only when already seen as an id (relation values), so a wrong value is not hidden
    if (s !== "" && ids.has(s)) return placeholder(s);
    return s;
  }
  return value;
}

async function snapshot(
  target: Target,
  res: Response,
  extraHeaders: string[],
): Promise<Snapshot> {
  const headers: Record<string, string> = {};
  for (const [k, v] of res.headers)
    if (KEPT_HEADERS.test(k) || extraHeaders.includes(k)) headers[k] = v;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let body: unknown = text;
  if (
    bytes.length > 0 &&
    !headers["content-type"]?.startsWith("application/json")
  )
    body = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  else
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
  opts: { headers?: string[] } = {},
): Promise<[Snapshot, Snapshot]> {
  const extra = opts.headers ?? [];
  if (!active) throw new Error("startTargets() was not called");
  const { pb, hb } = active;
  return Promise.all([
    fn(pb).then((r) => snapshot(pb, r, extra)),
    fn(hb).then((r) => snapshot(hb, r, extra)),
  ]);
}

// polls every 50 ms, throws with the last value
export async function waitUntil<T>(
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  timeoutMs = 2000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() >= end)
      throw new Error(`waitUntil timed out, last value: ${Bun.inspect(v)}`);
    await Bun.sleep(50);
  }
}

// both servers write a batch of 200 log entries at once, so 200 cheap requests flush every earlier entry
export async function flushLogs(t: Target): Promise<void> {
  await Promise.all(
    Array.from({ length: 200 }, () =>
      fetch(`${t.url}/api/health?__flush`).then((r) => r.arrayBuffer()),
    ),
  );
}

export function expectSame(a: Snapshot, b: Snapshot): void {
  expect(b).toEqual(a);
}
