import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testApp } from "../test-app";
import { loadHooksDir } from "./hooks-dir";

const dir = mkdtempSync(join(tmpdir(), "hb-hooks-"));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("hb_hooks files register in file name order and a bad file names itself", async () => {
  writeFileSync(
    join(dir, "b.ts"),
    "export default (app) => { app.loaded.push('b'); };",
  );
  writeFileSync(
    join(dir, "a.js"),
    "export default async (app) => { app.loaded.push('a'); };",
  );
  writeFileSync(join(dir, "types.d.ts"), "export {};");
  const app = testApp({ hooksDir: dir, argv: [] }) as ReturnType<
    typeof testApp
  > & {
    loaded: string[];
  };
  try {
    app.loaded = [];
    await loadHooksDir(app);
    expect(app.loaded).toEqual(["a", "b"]);

    writeFileSync(join(dir, "c.ts"), "export const x = 1;");
    await expect(loadHooksDir(app)).rejects.toThrow(
      "failed to load hooks c.ts: the default export must be a function that takes the app",
    );
  } finally {
    app.close();
  }
});
