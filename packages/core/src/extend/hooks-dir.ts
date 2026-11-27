import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { App } from "../app";

// Each file's default export is called with the app before it bootstraps, in file name order.
export async function loadHooksDir(app: App): Promise<void> {
  const dir = app.hooksDir;
  if (!existsSync(dir)) return;
  const files = readdirSync(dir)
    .filter(
      (f) =>
        /\.(ts|js)$/.test(f) &&
        !/\.(d|test)\.ts$/.test(f) &&
        statSync(resolve(dir, f)).isFile(),
    )
    .sort();
  for (const file of files) {
    try {
      const register = (await import(resolve(dir, file))).default;
      if (typeof register !== "function")
        throw new Error(
          "the default export must be a function that takes the app",
        );
      await register(app);
    } catch (err) {
      throw new Error(
        `failed to load hooks ${file}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
}
