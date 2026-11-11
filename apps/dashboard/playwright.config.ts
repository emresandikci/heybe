import { defineConfig } from "@playwright/test";
import { readState } from "./e2e/state";

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  retries: 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  use: {
    browserName: "chromium",
    headless: true,
    baseURL: readState() && `${readState()!.url}/_/`,
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
  },
  projects: [
    { name: "setup", testMatch: "install.setup.ts" },
    {
      name: "flows",
      testMatch: "*.spec.ts",
      dependencies: ["setup"],
      use: { storageState: "e2e/.auth/superuser.json" },
    },
  ],
});
