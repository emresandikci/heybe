import { expect, test } from "@playwright/test";

const trigger = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: "admin@example.com" });

test("user menu opens with the keyboard and Escape returns focus to the trigger", async ({
  page,
}) => {
  await page.goto("#/collections");
  await trigger(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(
    page.getByRole("menu").locator("[aria-checked=true]"),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(trigger(page)).toBeFocused();
});

test("user menu near the right edge stays inside the viewport", async ({
  page,
}) => {
  await page.goto("#/collections");
  await trigger(page).click();
  const viewport = page.viewportSize()!;
  await expect
    .poll(async () => {
      const box = (await page.getByRole("menu").boundingBox())!;
      return (
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= viewport.width &&
        box.y + box.height <= viewport.height
      );
    })
    .toBe(true);
});

test("closing the user menu with an outside click neither sticks nor steals focus", async ({
  page,
}) => {
  await page.goto("#/collections");
  await trigger(page).click();
  await page.getByRole("banner").click({ position: { x: 20, y: 20 } });
  await expect(page.getByRole("menu")).toBeHidden();
  expect(
    await page.evaluate(() => document.activeElement?.closest("[role=menu]")),
  ).toBeNull();

  await trigger(page).click();
  const link = page.getByRole("link", { name: "Logs" });
  await link.click();
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(link).toBeFocused();
});

test("a tooltip inside a modal dialog is on top and usable, and Escape closes only the tooltip", async ({
  page,
}) => {
  await page.goto("#/collections/_superusers");
  await page.getByRole("button", { name: "API preview" }).click();
  const dialog = page.getByRole("dialog", { name: "API preview" });
  await dialog.getByRole("button", { name: "Copy snippet" }).focus();
  const tooltip = dialog.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  expect(
    await tooltip.evaluate((tip) => {
      const box = tip.getBoundingClientRect();
      return tip.contains(
        document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        ),
      );
    }),
  ).toBe(true);
  await tooltip.hover();
  await expect(tooltip).toBeVisible();

  await dialog.getByRole("button", { name: "Copy snippet" }).focus();
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
