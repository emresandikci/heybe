import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clearState, writeState } from "./state";

const READY_TIMEOUT_MS = 10_000;
const POLL_MS = 50;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default async function globalSetup() {
  clearState();
  const tmp = mkdtempSync(join(tmpdir(), "hb-e2e-"));
  const dataDir = join(tmp, "hb_data");
  const migrationsDir = join(tmp, "migrations");
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(
    "bun",
    [
      "e2e/server.ts",
      "serve",
      "--http",
      `127.0.0.1:${port}`,
      "--dir",
      dataDir,
      "--migrationsDir",
      migrationsDir,
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  const fail = (reason: string) => {
    child.kill("SIGKILL");
    return new Error(`${reason}\n--- server output ---\n${output}`);
  };
  const installerUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(fail("No installer URL within 10000 ms")),
      READY_TIMEOUT_MS,
    );
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/\S+\/_\/#\/hbinstall\/\S+/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[0]);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(fail(`Server exited with code ${code}`));
    });
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (
    !(await fetch(`${url}/api/health`).then(
      (r) => r.ok,
      () => false,
    ))
  ) {
    if (Date.now() > deadline)
      throw fail("GET /api/health not ready within 10000 ms");
    await sleep(POLL_MS);
  }

  writeState({ url, installerUrl, dataDir, migrationsDir, pid: child.pid! });
}
