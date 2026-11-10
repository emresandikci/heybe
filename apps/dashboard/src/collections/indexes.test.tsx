import { expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { fakeServer } from "../test/fake-server";
import {
  echoPatch,
  fieldGroup,
  openEditor,
  serveCollections,
} from "../test/editor";
import { collectionsFixture, scaffoldsFixture } from "../test/fixtures";
import { renderApp } from "../test/render";

const posts = collectionsFixture.find((c) => c.name === "posts")!;

async function addIndex(
  user: Awaited<ReturnType<typeof openEditor>>["user"],
  columns: string[],
  unique = false,
) {
  await user.click(screen.getByRole("button", { name: "Add index" }));
  const dialog = screen.getByRole("dialog", { name: "Add index" });
  for (const column of columns)
    await user.click(within(dialog).getByLabelText(column));
  if (unique) await user.click(within(dialog).getByLabelText("Unique"));
  const sql = (
    within(dialog).getByLabelText("Index SQL") as HTMLTextAreaElement
  ).value;
  await user.click(within(dialog).getByRole("button", { name: "Save index" }));
  return sql;
}

const indexRows = () =>
  within(screen.getByRole("region", { name: "Indexes" })).queryAllByRole(
    "listitem",
  );

test("adding an index sends the built SQL in indexes", async () => {
  const server = echoPatch(fakeServer(), posts);
  const { user, save } = await openEditor("posts", server);
  const sql = await addIndex(user, ["title", "views"], true);
  expect(sql).toMatch(
    /^CREATE UNIQUE INDEX `idx_[a-zA-Z0-9]{10}` ON `posts` \(`title`, `views`\)$/,
  );
  expect(indexRows()[0]!.textContent).toContain("title, views");
  await save();
  await screen.findByText("Collection saved.");
  const [patch] = server.find("PATCH", "/api/collections/pbc_posts");
  expect((patch!.body as { indexes: string[] }).indexes).toEqual([sql]);
});

test("index SQL can be edited by hand and removed", async () => {
  const server = echoPatch(fakeServer(), posts);
  const { user, save } = await openEditor("posts", server);
  await addIndex(user, ["title"]);
  await addIndex(user, ["views"]);
  await user.click(
    within(indexRows()[0]!).getByRole("button", { name: "Edit index" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Edit index" });
  const area = within(dialog).getByLabelText("Index SQL");
  await user.clear(area);
  await user.type(area, "CREATE INDEX idx_t ON posts (title DESC)");
  await user.click(within(dialog).getByRole("button", { name: "Save index" }));
  await user.click(
    within(indexRows()[1]!).getByRole("button", { name: "Remove index" }),
  );
  await save();
  await screen.findByText("Collection saved.");
  const [patch] = server.find("PATCH", "/api/collections/pbc_posts");
  expect((patch!.body as { indexes: string[] }).indexes).toEqual([
    "CREATE INDEX idx_t ON posts (title DESC)",
  ]);
});

test("index error shows on its row", async () => {
  const server = fakeServer().on(
    "PATCH",
    "/api/collections/:id",
    {
      code: 400,
      message: "Failed to update collection.",
      data: { indexes: { 1: { message: "Bad index." } } },
    },
    400,
  );
  const { user, save } = await openEditor("posts", server);
  await addIndex(user, ["title"]);
  await addIndex(user, ["views"]);
  await save();
  await within(indexRows()[1]!).findByText("Bad index.");
  expect(within(indexRows()[0]!).queryByText("Bad index.")).toBeNull();
});

test("renaming a field, then editing indexes, then renaming again keeps every index right", async () => {
  const withIndex = {
    ...posts,
    indexes: ["CREATE INDEX `idx_t` ON `posts` (`title`)"],
  };
  const items = collectionsFixture.map((c) =>
    c.id === posts.id ? withIndex : c,
  );
  const server = echoPatch(serveCollections(fakeServer(), items), withIndex);
  const { user, save } = await openEditor("posts", server);
  const rename = async (from: string, to: string) => {
    const input = within(fieldGroup(from)).getByLabelText("Field name");
    await user.clear(input);
    await user.type(input, to);
  };
  await rename("title", "headline");
  expect(indexRows()[0]!.textContent).toContain("headline");
  const added = await addIndex(user, ["views"]);
  await rename("views", "hits");
  expect(indexRows()[1]!.textContent).toContain("hits");
  await save();
  await user.click(
    within(screen.getByRole("dialog", { name: "Confirm changes" })).getByRole(
      "button",
      { name: "Confirm" },
    ),
  );
  await screen.findByText("Collection saved.");
  const [patch] = server.find("PATCH", "/api/collections/pbc_posts");
  expect((patch!.body as { indexes: string[] }).indexes).toEqual([
    "CREATE INDEX `idx_t` ON `posts` (`headline`)",
    added.replace("`views`", "`hits`"),
  ]);
});

test("indexes with SQL the checkboxes cannot show keep their SQL", async () => {
  const sql =
    "CREATE INDEX `idx_t` ON `posts` (`title` DESC) WHERE `title` != ''";
  const withIndex = { ...posts, indexes: [sql] };
  const items = collectionsFixture.map((c) =>
    c.id === posts.id ? withIndex : c,
  );
  const server = echoPatch(serveCollections(fakeServer(), items), withIndex);
  const { user, save } = await openEditor("posts", server);
  await user.click(
    within(indexRows()[0]!).getByRole("button", { name: "Edit index" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Edit index" });
  expect(
    (within(dialog).getByLabelText("title") as HTMLInputElement).disabled,
  ).toBe(true);
  expect(
    (within(dialog).getByLabelText("Unique") as HTMLInputElement).disabled,
  ).toBe(true);
  await user.click(within(dialog).getByRole("button", { name: "Save index" }));
  await save();
  await screen.findByText("Collection saved.");
  const [patch] = server.find("PATCH", "/api/collections/pbc_posts");
  expect((patch!.body as { indexes: string[] }).indexes).toEqual([sql]);
});

test("switching a new collection from auth to base drops the auth indexes after an index edit", async () => {
  const server = fakeServer()
    .on("GET", "/api/collections/meta/scaffolds", scaffoldsFixture)
    .on("POST", "/api/collections", { ...posts, id: "pbc_members" });
  const { user } = renderApp({ path: "/collections/pbc_posts", server });
  await user.click(
    await screen.findByRole("button", { name: "New collection" }),
  );
  const dialog = screen.getByRole("dialog", { name: "New collection" });
  await user.type(await within(dialog).findByLabelText("Name"), "members");
  await user.selectOptions(within(dialog).getByLabelText("Type"), "auth");
  const sql = await addIndex(user, ["id"]);
  await user.selectOptions(within(dialog).getByLabelText("Type"), "base");
  await user.click(within(dialog).getByRole("button", { name: "Create" }));
  await screen.findByText("Collection created.");
  const [create] = server.find("POST", "/api/collections");
  expect((create!.body as { indexes: string[] }).indexes).toEqual([sql]);
});
