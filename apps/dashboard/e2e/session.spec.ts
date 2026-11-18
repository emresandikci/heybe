import { expect, test } from "@playwright/test";

test("theme persists, sign out and keyboard sign in", async ({ page }) => {
  await page.goto("#/collections");
  await page.getByRole("button", { name: "admin@example.com" }).click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByRole("button", { name: "admin@example.com" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/#\/login$/);

  const email = page.getByLabel("Email");
  await expect(email).toBeFocused();
  await page.keyboard.type("admin@example.com");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Password")).toBeFocused();
  await page.keyboard.type("1234567890");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("navigation", { name: "Collections" }),
  ).toBeVisible();
});
