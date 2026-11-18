import { expect, test } from "@playwright/test";
import { state } from "./state";

// the logger writes a batch after 3 s without new logs or once 200 are queued
const LOG_BATCH_SIZE = 200;

test("application name, SQL runner, logs and backups", async ({ page }) => {
  await page.goto("#/settings");
  await page.getByLabel("Application name").fill("E2E App");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Application name")).toHaveValue("E2E App");

  await page.goto("#/settings/sql");
  await page.getByLabel("SQL query").fill("select 1 as one");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(
    page
      .getByRole("table", { name: "Result" })
      .getByRole("cell", { name: "1", exact: true }),
  ).toBeVisible();

  for (let i = 0; i < LOG_BATCH_SIZE; i++)
    await fetch(`${state().url}/api/health`);
  await page.goto("#/logs");
  await expect(
    page.getByRole("table", { name: "Logs" }).locator("tbody tr").first(),
  ).toBeVisible();

  await page.goto("#/settings/backups");
  await page.getByRole("button", { name: "Create backup" }).click();
  await page
    .getByRole("dialog", { name: "Create backup" })
    .getByRole("button", { name: "Create", exact: true })
    .click();
  await expect(
    page.getByRole("table", { name: "Backups" }).getByRole("cell", {
      name: /\.zip$/,
    }),
  ).toBeVisible();
});

test("auth providers: configure GitHub", async ({ page }) => {
  await page.goto("#/settings/auth-providers");
  await page.getByRole("switch", { name: "Enable OAuth2" }).click();
  await expect(page.getByText("Auth providers saved.")).toBeVisible();
  await page.getByRole("button", { name: "Configure GitHub" }).click();
  const dialog = page.getByRole("dialog", { name: "GitHub provider" });
  await dialog.getByLabel("Client ID").fill("gh-id");
  await dialog.getByLabel("Client secret").fill("gh-secret");
  await dialog.getByRole("button", { name: "Save provider" }).click();
  await expect(page.getByText("Auth providers saved.")).toBeVisible();
  await expect(
    page
      .getByRole("list", { name: "Enabled providers" })
      .getByRole("listitem")
      .filter({ hasText: "GitHub" })
      .getByText("Enabled"),
  ).toBeVisible();
});
