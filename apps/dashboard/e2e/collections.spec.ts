import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { state } from "./state";

type Field = { id: string; name: string };

const migrations = (action: string) =>
  readdirSync(state().migrationsDir).filter((f) =>
    f.endsWith(`_${action}_posts.ts`),
  );

const readMigration = (file: string) =>
  readFileSync(join(state().migrationsDir, file), "utf8");

async function addField(dialog: Locator, type: string, name: string) {
  await dialog.getByLabel("New field type").selectOption(type);
  await dialog.getByRole("button", { name: "Add field" }).click();
  const row = dialog.getByRole("group", { name: "field", exact: true });
  await row.getByLabel("Field name").fill(name);
  return dialog.getByRole("group", { name, exact: true });
}

test("collection create, field rename and delete write automigrate files", async ({
  page,
}) => {
  await page.goto("#/collections");
  await page.getByRole("button", { name: "New collection" }).click();
  const create = page.getByRole("dialog", { name: "New collection" });
  await create.getByLabel("Name", { exact: true }).fill("posts");
  await addField(create, "text", "title");
  await addField(create, "file", "cover");
  const tags = await addField(create, "select", "tags");
  await tags.getByLabel("Values").fill("a\nb");
  await tags.getByLabel("Allow multiple").check();
  const author = await addField(create, "relation", "author");
  await author
    .getByLabel("Collection", { exact: true })
    .selectOption({ label: "users" });
  await create.getByRole("tab", { name: "API rules" }).click();
  await create
    .getByRole("group", { name: "List/Search rule" })
    .getByLabel("Superusers only")
    .uncheck();
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "posts", level: 1 }),
  ).toBeVisible();

  await expect.poll(() => migrations("created")).toHaveLength(1);
  const created = JSON.parse(
    readMigration(migrations("created")[0]!).match(
      /newCollection\((\{[\s\S]*?\n  \})\);/,
    )![1]!,
  ) as { fields: Field[]; listRule: string | null };
  const title = created.fields.find((f) => f.name === "title")!;
  expect(created.fields.map((f) => f.name)).toEqual(
    expect.arrayContaining(["title", "cover", "tags", "author"]),
  );
  expect(created.listRule).toBe("");

  await page.getByRole("button", { name: "Edit collection posts" }).click();
  const edit = page.getByRole("dialog", { name: "Edit posts" });
  await edit
    .getByRole("group", { name: "title", exact: true })
    .getByLabel("Field name")
    .fill("headline");
  await edit.getByRole("button", { name: "Save changes" }).click();
  const changes = page.getByRole("dialog", { name: "Confirm changes" });
  await expect(changes).toContainText("Rename field title to headline");
  await changes.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Collection saved.")).toBeVisible();

  await expect.poll(() => migrations("updated")).toHaveLength(1);
  const updated = readMigration(migrations("updated")[0]!);
  const up = updated.slice(0, updated.indexOf("}, async (app) => {"));
  expect(up).not.toContain("removeFieldById");
  const renamed = JSON.parse(
    up.match(/addFieldAt\(collection, \d+, (\{[\s\S]*?\n  \})\);/)![1]!,
  ) as Field;
  expect(renamed).toMatchObject({ id: title.id, name: "headline" });

  await page.getByRole("button", { name: "Edit collection posts" }).click();
  await page
    .getByRole("dialog", { name: "Edit posts" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  const confirm = page.getByRole("dialog", { name: "Delete collection" });
  await confirm.getByLabel('Type "posts" to confirm').fill("posts");
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Collection deleted.")).toBeVisible();

  await expect.poll(() => migrations("deleted")).toHaveLength(1);
});
