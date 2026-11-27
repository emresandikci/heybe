import { parseArgs } from "node:util";

export const GLOBAL_OPTIONS = {
  dir: { type: "string" },
  dev: { type: "boolean" },
  migrationsDir: { type: "string" },
  hooksDir: { type: "string" },
  automigrate: { type: "boolean" },
} as const;

export function parseCommandArgs<
  O extends Record<string, { type: "string" | "boolean"; multiple?: boolean }>,
>(args: string[], options: O) {
  return parseArgs({
    args,
    options: { ...GLOBAL_OPTIONS, ...options },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
}
