import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { clearState, readState } from "./state";

const STOP_TIMEOUT_MS = 10_000;
const POLL_MS = 50;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export default async function globalTeardown() {
  const s = readState();
  if (!s) return;
  if (alive(s.pid)) process.kill(s.pid, "SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (alive(s.pid) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, POLL_MS));
  if (alive(s.pid)) process.kill(s.pid, "SIGKILL");
  rmSync(dirname(s.dataDir), { recursive: true, force: true });
  clearState();
}
