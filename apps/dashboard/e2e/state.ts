import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface E2EState {
  url: string;
  installerUrl: string;
  dataDir: string;
  migrationsDir: string;
  pid: number;
}

const file = fileURLToPath(new URL(".state.json", import.meta.url));

// workers load the config again after the global setup, so they see this run's server
export const readState = (): E2EState | undefined =>
  existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;

export const state = (): E2EState => {
  const s = readState();
  if (!s) throw new Error("e2e/.state.json is missing: run through playwright");
  return s;
};

export const writeState = (s: E2EState) =>
  writeFileSync(file, JSON.stringify(s, null, 2));

export const clearState = () => rmSync(file, { force: true });
