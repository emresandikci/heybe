import { expect, test } from "@playwright/test";

test("extension page and extensions.js", async ({ page }) => {
  await page.goto("#/collections");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Demo" })
    .click();
  await expect(
    page.getByText("Demo extension for admin@example.com"),
  ).toBeVisible();

  const res = await page.request.get("extensions.js");
  expect(res.ok()).toBe(true);
  expect(res.headers()["content-type"]).toMatch(/^text\/javascript/);
});
