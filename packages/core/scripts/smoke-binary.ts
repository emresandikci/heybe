import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { buildBinary } from "./build-binary";

const PNG_4X4 = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8AARwgWXg4ArpMP8bh5W0YAAAAASUVORK5CYII=",
);

const MIGRATION = `import { migrate } from "@heybejs/core";
export default migrate(async (app) => {
  await app.collections.save({
    name: "smoke",
    type: "base",
    fields: [{ name: "doc", type: "file", maxSelect: 1, thumbs: ["2x2"] }],
  });
});
`;

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`smoke check failed: ${message}`);
}

async function poll<T>(
  what: string,
  maxMs: number,
  fn: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = performance.now() + maxMs;
  while (performance.now() < deadline) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined) return value;
    await Bun.sleep(50);
  }
  throw new Error(`smoke check failed: ${what} within ${maxMs} ms`);
}

async function run(binary: string, args: string[], cwd?: string) {
  const proc = Bun.spawn([binary, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
}

export async function smoke(binary: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "heybe-smoke-"));
  const dir = join(root, "data");
  const migrations = join(root, "migrations");
  const cwd = join(root, "cwd");
  mkdirSync(migrations);
  mkdirSync(cwd);
  await Bun.write(join(migrations, "1700000000_smoke.ts"), MIGRATION);
  let server: Bun.Subprocess | undefined;
  try {
    const version = await run(binary, ["--version"], cwd);
    check(
      version.code === 0 && version.out === `heybe version ${pkg.version}\n`,
      `--version printed ${JSON.stringify(version.out)}`,
    );
    const help = await run(binary, ["serve", "--help"], cwd);
    check(help.code === 0 && help.out.includes("Usage:"), "serve --help");
    check(readdirSync(cwd).length === 0, "help left files in the cwd");

    const upsert = await run(binary, [
      "superuser",
      "upsert",
      "smoke@example.com",
      "1234567890",
      "--dir",
      dir,
    ]);
    check(upsert.code === 0, `superuser upsert: ${upsert.err}`);

    const port = freePort();
    const base = `http://127.0.0.1:${port}`;
    const started = performance.now();
    server = Bun.spawn(
      [
        binary,
        "serve",
        "--http",
        `127.0.0.1:${port}`,
        "--dir",
        dir,
        "--migrationsDir",
        migrations,
      ],
      { stdout: "ignore", stderr: "inherit" },
    );
    const health = () =>
      fetch(`${base}/api/health`).then((r) => (r.ok ? true : undefined));
    await poll("the server answers /api/health", 10000, health);
    const coldStart = Math.round(performance.now() - started);

    const index = await fetch(`${base}/_/`);
    check(
      index.status === 200 &&
        index.headers.get("content-type")?.startsWith("text/html"),
      `GET /_/ answered ${index.status}`,
    );
    const asset = /\/_\/assets\/[^"]+\.js/.exec(await index.text())?.[0];
    check(asset, "/_/ references no js asset");
    check((await fetch(base + asset)).status === 200, `GET ${asset}`);

    const auth = await fetch(
      `${base}/api/collections/_superusers/auth-with-password`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          identity: "smoke@example.com",
          password: "1234567890",
        }),
      },
    );
    check(auth.ok, `superuser auth answered ${auth.status}`);
    const headers = { authorization: (await auth.json()).token as string };
    const api = (path: string, init: RequestInit = {}) =>
      fetch(base + path, { ...init, headers: { ...headers, ...init.headers } });
    check(
      (await api("/api/collections/smoke")).status === 200,
      "the migration did not create the smoke collection",
    );

    const form = new FormData();
    form.append("doc", new File([PNG_4X4], "pixel.png"));
    const created = await api("/api/collections/smoke/records", {
      method: "POST",
      body: form,
    });
    check(created.ok, `record create answered ${created.status}`);
    const record = (await created.json()) as { id: string; doc: string };
    const thumb = await fetch(
      `${base}/api/files/smoke/${record.id}/${record.doc}?thumb=2x2`,
    );
    const png = new Uint8Array(await thumb.arrayBuffer());
    const view = new DataView(png.buffer);
    check(
      thumb.status === 200 &&
        thumb.headers.get("content-type") === "image/png" &&
        view.getUint32(16) === 2 &&
        view.getUint32(20) === 2,
      `thumb answered ${thumb.status} ${thumb.headers.get("content-type")}`,
    );

    const backup = await api("/api/backups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "smoke.zip" }),
    });
    check(
      backup.status === 204,
      `backup create answered ${backup.status} ${await backup.text()}`,
    );
    // restore needs a process restart, which Windows does not support (same as PocketBase)
    if (process.platform !== "win32") {
      const recordUrl = `/api/collections/smoke/records/${record.id}`;
      check(
        (await api(recordUrl, { method: "DELETE" })).status === 204,
        "record delete",
      );
      const restore = await api("/api/backups/smoke.zip/restore", {
        method: "POST",
      });
      check(restore.status === 204, `restore answered ${restore.status}`);
      await poll("the restored record is served after the restart", 15000, () =>
        api(recordUrl).then((r) => (r.ok ? true : undefined)),
      );
      check(
        server.exitCode === null,
        "the server exited instead of restarting",
      );
    }

    server.kill("SIGTERM");
    const code = await Promise.race([server.exited, Bun.sleep(5000)]);
    check(
      code === 0 || (process.platform === "win32" && typeof code === "number"),
      `serve did not exit on SIGTERM within 5000 ms`,
    );
    server = undefined;

    const size = (statSync(binary).size / 1024 / 1024).toFixed(1);
    console.log(`binary size: ${size} MB`);
    console.log(`cold start: ${coldStart} ms`);
  } finally {
    if (server) {
      server.kill("SIGKILL");
      await server.exited;
    }
    await removeDir(root);
  }
}

// Windows keeps file locks for a moment after the process exits
async function removeDir(dir: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== "EBUSY" && code !== "EPERM")) throw err;
      await Bun.sleep(250);
    }
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { binary: { type: "string" } } });
  try {
    let binary = values.binary;
    if (!binary) {
      binary = resolve(
        import.meta.dir,
        process.platform === "win32" ? "../dist/heybe.exe" : "../dist/heybe",
      );
      await buildBinary({ outfile: binary });
    }
    await smoke(resolve(binary));
    console.log("smoke: ok");
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
