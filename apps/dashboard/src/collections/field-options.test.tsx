import { expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { fakeServer } from "../test/fake-server";
import {
  echoPatch,
  fieldGroup,
  openEditor,
  patchedFields,
  paste,
} from "../test/editor";
import { collectionsFixture } from "../test/fixtures";

const posts = collectionsFixture.find((c) => c.name === "posts")!;
const stats = collectionsFixture.find((c) => c.name === "stats")!;

async function addField(type: string) {
  const server = echoPatch(fakeServer(), posts);
  const app = await openEditor("posts", server);
  await app.user.selectOptions(
    within(app.dialog).getByLabelText("New field type"),
    type,
  );
  await app.user.click(
    within(app.dialog).getByRole("button", { name: "Add field" }),
  );
  const group = within(fieldGroup("field"));
  const saved = async () => {
    await app.save();
    await screen.findByText("Collection saved.");
    return patchedFields(server).at(-1)!;
  };
  return { ...app, server, group, saved };
}

test("file options write maxSelect, maxSize, mimeTypes, thumbs and protected", async () => {
  const { user, group, saved } = await addField("file");
  await user.click(group.getByLabelText("Allow multiple"));
  await user.type(group.getByLabelText("Max size (bytes)"), "5242880");
  await paste(
    user,
    group.getByLabelText("MIME types"),
    "image/png, image/jpeg",
  );
  await paste(user, group.getByLabelText("Thumb sizes"), "100x100, 0x300");
  await user.click(group.getByLabelText("Protected"));
  expect(await saved()).toMatchObject({
    type: "file",
    maxSelect: 99,
    maxSize: 5242880,
    mimeTypes: ["image/png", "image/jpeg"],
    thumbs: ["100x100", "0x300"],
    protected: true,
  });
});

test("file MIME presets add their types once", async () => {
  const { user, group, saved } = await addField("file");
  await user.click(group.getByRole("button", { name: "Images" }));
  await user.click(group.getByRole("button", { name: "Images" }));
  const field = await saved();
  expect(field.mimeTypes).toContain("image/png");
  expect(new Set(field.mimeTypes as string[]).size).toBe(
    (field.mimeTypes as string[]).length,
  );
});

test("select multiple sets maxSelect to the values count, single to 1", async () => {
  const { user, group, saved } = await addField("select");
  await user.type(group.getByLabelText("Values"), "a{Enter}b{Enter}c");
  await user.click(group.getByLabelText("Allow multiple"));
  expect((group.getByLabelText("Max select") as HTMLInputElement).value).toBe(
    "3",
  );
  await user.click(group.getByLabelText("Allow multiple"));
  expect(group.queryByLabelText("Max select")).toBeNull();
  expect(await saved()).toMatchObject({
    values: ["a", "b", "c"],
    maxSelect: 1,
  });
});

test("relation picks collectionId and cascadeDelete", async () => {
  const { user, group, saved } = await addField("relation");
  const target = group.getByLabelText("Collection");
  expect(within(target).queryByRole("option", { name: "stats" })).toBeNull();
  await user.selectOptions(target, "_pb_users_auth_");
  await user.click(group.getByLabelText("Cascade delete"));
  await user.click(group.getByLabelText("Allow multiple"));
  await user.type(group.getByLabelText("Min select"), "1");
  expect(await saved()).toMatchObject({
    type: "relation",
    collectionId: "_pb_users_auth_",
    cascadeDelete: true,
    maxSelect: 999,
    minSelect: 1,
  });
});

test("number empty min sends null", async () => {
  const { user, group, saved } = await addField("number");
  await user.type(group.getByLabelText("Min"), "5");
  await user.clear(group.getByLabelText("Min"));
  await user.type(group.getByLabelText("Max"), "10");
  await user.click(group.getByLabelText("Integers only"));
  expect(await saved()).toMatchObject({ min: null, max: 10, onlyInt: true });
});

test("number limits accept decimals", async () => {
  const { user, group, saved } = await addField("number");
  for (const label of ["Min", "Max"])
    expect(group.getByLabelText(label).getAttribute("step")).toBe("any");
  await user.type(group.getByLabelText("Max"), "1.5");
  expect(await saved()).toMatchObject({ max: 1.5 });
});

test("Max select stays while it is edited", async () => {
  const { user, group, saved } = await addField("file");
  await user.click(group.getByLabelText("Allow multiple"));
  await user.clear(group.getByLabelText("Max select"));
  await user.type(group.getByLabelText("Max select"), "5");
  expect(await saved()).toMatchObject({ maxSelect: 5 });
});

test("json options are written", async () => {
  const json = await addField("json");
  await json.user.type(json.group.getByLabelText("Max size (bytes)"), "100");
  expect(await json.saved()).toMatchObject({ type: "json", maxSize: 100 });
});

test("editor options are written", async () => {
  const { user, group, saved } = await addField("editor");
  await user.type(group.getByLabelText("Max size (bytes)"), "2048");
  await user.click(group.getByLabelText("Convert URLs"));
  expect(await saved()).toMatchObject({ maxSize: 2048, convertURLs: true });
});

test("date options are written", async () => {
  const { user, group, saved } = await addField("date");
  await paste(
    user,
    group.getByLabelText("Min date"),
    "2026-01-01 00:00:00.000Z",
  );
  await paste(
    user,
    group.getByLabelText("Max date"),
    "2027-01-01 00:00:00.000Z",
  );
  expect(await saved()).toMatchObject({
    min: "2026-01-01 00:00:00.000Z",
    max: "2027-01-01 00:00:00.000Z",
  });
});

test("password options are written", async () => {
  const { user, group, saved } = await addField("password");
  await user.type(group.getByLabelText("Min length"), "8");
  await user.type(group.getByLabelText("Max length"), "64");
  await user.type(group.getByLabelText("Pattern"), "\\d");
  await user.type(group.getByLabelText("Bcrypt cost"), "12");
  expect(await saved()).toMatchObject({
    min: 8,
    max: 64,
    pattern: "\\d",
    cost: 12,
  });
});

test("url except domains are written", async () => {
  const { user, group, saved } = await addField("url");
  await user.type(group.getByLabelText("Except domains"), "bad.test");
  expect(
    (group.getByLabelText("Only domains") as HTMLInputElement).disabled,
  ).toBe(true);
  expect(await saved()).toMatchObject({
    exceptDomains: ["bad.test"],
    onlyDomains: [],
  });
});

test("an option error on a saved field opens its options next to the input", async () => {
  const server = fakeServer().on(
    "PATCH",
    "/api/collections/:id",
    {
      code: 400,
      message: "Failed to update collection.",
      data: { fields: { 2: { max: { message: "Too small." } } } },
    },
    400,
  );
  const { save, dialog } = await openEditor("posts", server);
  const group = within(fieldGroup("views"));
  expect(group.queryByLabelText("Max")).toBeNull();
  await save();
  await group.findByText("Too small.");
  expect(group.getByLabelText("Max").getAttribute("aria-invalid")).toBe("true");
  expect(within(dialog).getByRole("alert").textContent).not.toContain("max");
});

test("list item errors show on the list input", async () => {
  const server = fakeServer().on(
    "PATCH",
    "/api/collections/:id",
    {
      code: 400,
      message: "Failed to update collection.",
      data: {
        fields: { 15: { thumbs: { 0: { message: "Must not be in list." } } } },
      },
    },
    400,
  );
  const app = await openEditor("posts", server);
  await app.user.selectOptions(
    within(app.dialog).getByLabelText("New field type"),
    "file",
  );
  await app.user.click(
    within(app.dialog).getByRole("button", { name: "Add field" }),
  );
  const group = within(fieldGroup("field"));
  await app.user.type(group.getByLabelText("Thumb sizes"), "0x0");
  await app.save();
  await group.findByText("0x0: Must not be in list.");
  expect(group.getByLabelText("Thumb sizes").getAttribute("aria-invalid")).toBe(
    "true",
  );
  expect(within(app.dialog).getByRole("alert").textContent).not.toContain(
    "thumbs",
  );
});

test("email only domains and except domains are exclusive", async () => {
  const { user, group, saved } = await addField("email");
  await user.type(group.getByLabelText("Except domains"), "spam.test");
  await user.clear(group.getByLabelText("Except domains"));
  await paste(user, group.getByLabelText("Only domains"), "a.test, b.test");
  expect(
    (group.getByLabelText("Except domains") as HTMLInputElement).disabled,
  ).toBe(true);
  expect(await saved()).toMatchObject({
    onlyDomains: ["a.test", "b.test"],
    exceptDomains: [],
  });
});

test("text options and help text are written", async () => {
  const text = await addField("text");
  await text.user.type(text.group.getByLabelText("Min length"), "2");
  await text.user.type(text.group.getByLabelText("Max length"), "20");
  await text.user.type(text.group.getByLabelText("Pattern"), "^[[a-z]+$");
  await paste(text.user, text.group.getByLabelText("Help text"), "Lowercase.");
  expect(await text.saved()).toMatchObject({
    min: 2,
    max: 20,
    pattern: "^[a-z]+$",
    help: "Lowercase.",
  });
});

test("autodate starts on create and writes on update", async () => {
  const auto = await addField("autodate");
  expect(
    (auto.group.getByLabelText("On create") as HTMLInputElement).checked,
  ).toBe(true);
  await auto.user.click(auto.group.getByLabelText("On update"));
  expect(await auto.saved()).toMatchObject({ onCreate: true, onUpdate: true });
});

test("Move down swaps fields and keeps ids", async () => {
  const server = echoPatch(fakeServer(), posts);
  const { user, save } = await openEditor("posts", server);
  await user.click(
    within(fieldGroup("title")).getByRole("button", { name: "Move down" }),
  );
  await save();
  await screen.findByText("Collection saved.");
  expect(
    patchedFields(server)
      .slice(1, 3)
      .map((f) => [f.id, f.name]),
  ).toEqual([
    ["number_views", "views"],
    ["text_title", "title"],
  ]);
});

test("view collection sends viewQuery and no fields edits", async () => {
  const server = echoPatch(fakeServer(), stats);
  const { user, dialog, save } = await openEditor("stats", server);
  expect(within(dialog).getByRole("tab", { name: "Query" })).toBeTruthy();
  expect(
    within(within(dialog).getByRole("list", { name: "View fields" })).getByText(
      "title",
    ),
  ).toBeTruthy();
  expect(
    within(dialog).queryByRole("button", { name: "Add index" }),
  ).toBeNull();
  const query = within(dialog).getByLabelText("Select query");
  await user.clear(query);
  await paste(user, query, "SELECT id FROM posts");
  await save();
  await screen.findByText("Collection saved.");
  const [patch] = server.find("PATCH", "/api/collections/pbc_stats");
  expect(patch!.body).toMatchObject({ viewQuery: "SELECT id FROM posts" });
  expect(patch!.body).not.toHaveProperty("fields");
});
