import { expect, test } from "@playwright/test";
import { api } from "./api";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("record create with a file, filter, edit and delete", async ({ page }) => {
  await api("/api/collections", {
    method: "POST",
    body: JSON.stringify({
      name: "notes",
      type: "base",
      fields: [
        { name: "title", type: "text" },
        { name: "cover", type: "file", maxSelect: 1 },
      ],
    }),
  });

  await page.goto("#/collections/notes");
  await page.getByRole("button", { name: "New record" }).first().click();
  const create = page.getByRole("dialog", { name: "New record" });
  await create.getByLabel("title", { exact: true }).fill("hello");
  await create.getByLabel("Add files").setInputFiles({
    name: "cat 1.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await expect(create).toBeHidden();

  const table = page.getByRole("table", { name: "notes records" });
  const thumb = table.getByRole("img", { name: /^cat_1_\w+\.png$/ });
  await expect(thumb).toBeVisible();
  await expect
    .poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);

  const filter = page.getByLabel("Filter records");
  await filter.fill('title ~ "hel"');
  await filter.press("Enter");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await filter.fill('title = "x"');
  await filter.press("Enter");
  await expect(page.getByText("No records match this filter")).toBeVisible();
  await page.getByRole("button", { name: "Clear", exact: true }).click();

  await table.getByRole("cell", { name: "hello", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit record" });
  await edit.getByLabel("title", { exact: true }).fill("hello again");
  await edit.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(
    table.getByRole("cell", { name: "hello again", exact: true }),
  ).toBeVisible();

  await table.getByRole("cell", { name: "hello again", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Edit record" });
  await drawer.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Delete record" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(page.getByText("No records yet")).toBeVisible();
});

test("rich text field saves bold text as HTML", async ({ page }) => {
  await api("/api/collections", {
    method: "POST",
    body: JSON.stringify({
      name: "articles",
      type: "base",
      fields: [{ name: "body", type: "editor" }],
    }),
  });

  await page.goto("#/collections/articles");
  await page.getByRole("button", { name: "New record" }).first().click();
  const drawer = page.getByRole("dialog", { name: "New record" });
  await drawer.getByRole("textbox", { name: "body" }).click();
  await drawer.getByRole("button", { name: "Bold" }).click();
  await page.keyboard.type("hello");
  await expect(drawer.getByRole("textbox", { name: "body" })).toHaveText(
    "hello",
  );
  await drawer.getByRole("button", { name: "Create", exact: true }).click();
  await expect(drawer).toBeHidden();

  const { items } = await api<{ items: { body: string }[] }>(
    "/api/collections/articles/records",
  );
  expect(items.map((r) => r.body)).toEqual(["<p><strong>hello</strong></p>"]);
});
