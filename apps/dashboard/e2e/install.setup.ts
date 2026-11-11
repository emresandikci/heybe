import { expect, test as setup } from "@playwright/test";
import { state } from "./state";

setup("installer creates the first superuser", async ({ page }) => {
  await page.goto(state().installerUrl);
  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password", { exact: true }).fill("1234567890");
  await page.getByLabel("Confirm password").fill("1234567890");
  await page.getByRole("button", { name: "Create superuser" }).click();
  await expect(
    page.getByRole("navigation", { name: "Collections" }),
  ).toBeVisible();
  await page.context().storageState({ path: "e2e/.auth/superuser.json" });
});
