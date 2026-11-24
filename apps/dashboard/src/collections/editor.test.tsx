import { expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { fakeServer } from "../test/fake-server";
import {
  collectionsFixture,
  scaffoldsFixture,
  settingsFixture,
} from "../test/fixtures";
import { codeValue, fieldGroup, openEditor } from "../test/editor";
import { renderApp } from "../test/render";

const posts = collectionsFixture.find((c) => c.name === "posts")!;
const fieldAction = async (user: UserEvent, field: string, action: string) => {
  await user.click(
    within(fieldGroup(field)).getByRole("button", {
      name: `Actions for ${field}`,
    }),
  );
  await user.click(screen.getByRole("menuitem", { name: action }));
};

const editPosts = (server = fakeServer()) => openEditor("posts", server);

test("/collections opens the first non-system collection", async () => {
  const { router } = renderApp({ path: "/collections" });
  expect(
    await screen.findByRole("heading", {
      name: "Collections / posts",
      level: 1,
    }),
  ).toBeTruthy();
  expect(router.state.location.pathname).toBe("/collections/hbc_posts");
});

test("creating a base collection posts name, type and fields", async () => {
  const items = [...collectionsFixture];
  const server = fakeServer()
    .on("GET", "/api/collections", () => ({
      page: 1,
      perPage: 1000,
      totalItems: items.length,
      totalPages: 1,
      items,
    }))
    .on("GET", "/api/collections/meta/scaffolds", scaffoldsFixture)
    .on("POST", "/api/collections", (req) => {
      const created = { ...(req.body as typeof posts), id: "hbc_notes" };
      items.push(created);
      return created;
    });
  const { user, router } = renderApp({
    path: "/collections/hbc_posts",
    server,
  });
  await user.click(
    await screen.findByRole("button", { name: "New collection" }),
  );
  const dialog = screen.getByRole("dialog", { name: "New collection" });
  await user.type(await within(dialog).findByLabelText("Name"), "notes");
  await user.selectOptions(
    within(dialog).getByLabelText("New field type"),
    "text",
  );
  await user.click(within(dialog).getByRole("button", { name: "Add field" }));
  await user.click(within(dialog).getByRole("button", { name: "Create" }));

  await screen.findByRole("heading", { name: "Collections / notes", level: 1 });
  const body = server.find("POST", "/api/collections")[0]!.body as Record<
    string,
    unknown
  >;
  expect(body).toMatchObject({
    name: "notes",
    type: "base",
    fields: [scaffoldsFixture.base!.fields[0], { name: "field", type: "text" }],
  });
  expect(body).not.toHaveProperty("id");
  expect((body.fields as object[])[1]).not.toHaveProperty("id");
  expect(router.state.location.pathname).toBe("/collections/hbc_notes");
});

test("deleting a field shows the changes dialog before the PATCH and Cancel sends nothing", async () => {
  const server = fakeServer().on("PATCH", "/api/collections/:id", (req) => ({
    ...posts,
    ...(req.body as object),
  }));
  const { user, dialog } = await editPosts(server);
  await fieldAction(user, "views", "Remove field");
  const title = within(fieldGroup("title")).getByLabelText("Field name");
  await user.clear(title);
  await user.type(title, "headline");
  await user.click(
    within(dialog).getByRole("button", { name: "Save changes" }),
  );

  const changes = screen.getByRole("dialog", { name: "Confirm changes" });
  expect(changes.textContent).toContain("Delete field views");
  expect(changes.textContent).toContain("Rename field title to headline");
  await user.click(within(changes).getByRole("button", { name: "Cancel" }));
  expect(server.find("PATCH", "/api/collections/:id")).toHaveLength(0);

  await user.click(
    within(dialog).getByRole("button", { name: "Save changes" }),
  );
  await user.click(
    within(screen.getByRole("dialog", { name: "Confirm changes" })).getByRole(
      "button",
      { name: "Confirm" },
    ),
  );
  await screen.findByText("Collection saved.");
  const [patch] = server.find("PATCH", "/api/collections/hbc_posts");
  const fields = (patch!.body as { fields: { id: string; name: string }[] })
    .fields;
  expect(fields.map((f) => f.name)).not.toContain("views");
  expect(fields[1]).toMatchObject({ id: "text_title", name: "headline" });
});

test("server errors show under the field name input", async () => {
  const server = fakeServer().on(
    "PATCH",
    "/api/collections/:id",
    {
      code: 400,
      message: "Failed to update collection.",
      data: {
        fields: {
          1: {
            name: {
              code: "validation_not_unique",
              message: "Duplicated or invalid field name.",
            },
          },
        },
      },
    },
    400,
  );
  const { user, dialog } = await editPosts(server);
  await user.click(within(fieldGroup("title")).getByLabelText("Hidden"));
  await user.click(
    within(dialog).getByRole("button", { name: "Save changes" }),
  );

  const group = fieldGroup("title");
  await within(group).findByText("Duplicated or invalid field name.");
  expect(
    within(group).getByLabelText("Field name").getAttribute("aria-invalid"),
  ).toBe("true");
});

test("removing a field clears stale field errors", async () => {
  const server = fakeServer().on(
    "PATCH",
    "/api/collections/:id",
    {
      code: 400,
      message: "Failed to update collection.",
      data: { fields: { 2: { name: { message: "Bad name." } } } },
    },
    400,
  );
  const { user, dialog } = await editPosts(server);
  await user.click(
    within(dialog).getByRole("button", { name: "Save changes" }),
  );
  await within(fieldGroup("views")).findByText("Bad name.");
  await fieldAction(user, "title", "Remove field");
  expect(within(dialog).queryByText("Bad name.")).toBeNull();
});

test("switching the type of a new collection swaps the scaffold indexes", async () => {
  const server = fakeServer()
    .on("GET", "/api/collections/meta/scaffolds", scaffoldsFixture)
    .on("POST", "/api/collections", { ...posts, id: "hbc_members" });
  const { user } = renderApp({ path: "/collections/hbc_posts", server });
  await user.click(
    await screen.findByRole("button", { name: "New collection" }),
  );
  const dialog = screen.getByRole("dialog", { name: "New collection" });
  await user.type(await within(dialog).findByLabelText("Name"), "members");
  const type = within(dialog).getByLabelText("Type");
  await user.selectOptions(type, "auth");
  await user.selectOptions(type, "base");
  await user.selectOptions(type, "auth");
  await user.click(within(dialog).getByRole("button", { name: "Create" }));

  await screen.findByText("Collection created.");
  const [create] = server.find("POST", "/api/collections");
  expect((create!.body as { indexes: string[] }).indexes).toEqual([
    "CREATE UNIQUE INDEX `idx_tokenKey_abc` ON `members` (`tokenKey`)",
    "CREATE UNIQUE INDEX `idx_email_abc` ON `members` (`email`) WHERE `email` != ''",
  ]);
});

test("an unclaimed server error key is listed in the form errors", async () => {
  const server = fakeServer().on(
    "PATCH",
    "/api/collections/:id",
    {
      code: 400,
      message: "Failed to update collection.",
      data: { somethingNew: { message: "Bad." } },
    },
    400,
  );
  const { user, dialog } = await editPosts(server);
  await user.click(
    within(dialog).getByRole("button", { name: "Save changes" }),
  );
  const alert = await within(dialog).findByRole("alert");
  expect(alert.textContent).toContain("somethingNew: Bad.");
});

test("closing a dirty editor asks to discard", async () => {
  const { user, dialog } = await editPosts();
  await user.type(within(dialog).getByLabelText("Name"), "x");
  await user.keyboard("{Escape}");
  const ask = screen.getByRole("dialog", { name: "Discard unsaved changes?" });
  await user.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("dialog", { name: "Edit posts" })).toBeTruthy();

  await user.keyboard("{Escape}");
  await user.click(
    within(
      screen.getByRole("dialog", { name: "Discard unsaved changes?" }),
    ).getByRole("button", { name: "Discard" }),
  );
  expect(screen.queryByRole("dialog", { name: "Edit posts" })).toBeNull();
});

test("closing a clean editor does not ask", async () => {
  const { user } = await editPosts();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("system collection: name disabled and no Delete", async () => {
  const { user } = renderApp({ path: "/collections/hbc_3142635823" });
  await user.click(await screen.findByRole("button", { name: "System" }));
  await user.click(
    screen.getByRole("button", { name: "Edit collection _superusers" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Edit _superusers" });
  expect(
    (within(dialog).getByLabelText("Name") as HTMLInputElement).disabled,
  ).toBe(true);
  expect(within(dialog).queryByRole("button", { name: "Delete" })).toBeNull();
  expect(
    within(dialog).queryByRole("button", { name: "More actions" }),
  ).toBeNull();
  const email = within(fieldGroup("email"));
  expect(
    (email.getByLabelText("Field name") as HTMLInputElement).disabled,
  ).toBe(true);
  await user.click(email.getByRole("button", { name: "Actions for email" }));
  expect(screen.queryByRole("menuitem", { name: "Remove field" })).toBeNull();
});

test("hideControls hides New collection and Edit collection", async () => {
  const server = fakeServer().on("GET", "/api/settings", {
    ...settingsFixture,
    meta: { ...settingsFixture.meta, hideControls: true },
  });
  renderApp({ path: "/collections/hbc_posts", server });
  await screen.findByRole("heading", { name: "Collections / posts", level: 1 });
  await screen.findByRole("link", { name: "users" });
  expect(screen.queryByRole("button", { name: "New collection" })).toBeNull();
  expect(screen.queryAllByRole("button", { name: /^Edit collection/ })).toEqual(
    [],
  );
});

test("truncate requires typing the collection name", async () => {
  const server = fakeServer().on(
    "DELETE",
    "/api/collections/:id/truncate",
    () => undefined,
  );
  const { user, dialog } = await editPosts(server);
  await user.click(
    within(dialog).getByRole("button", { name: "More actions" }),
  );
  await user.click(screen.getByRole("menuitem", { name: "Truncate" }));
  const ask = screen.getByRole("dialog", { name: "Truncate collection" });
  const confirm = within(ask).getByRole("button", {
    name: "Truncate",
  }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  await user.type(
    within(ask).getByLabelText('Type "posts" to confirm'),
    "posts",
  );
  await user.click(confirm);
  await screen.findByText("Collection truncated.");
  expect(
    server.find("DELETE", "/api/collections/hbc_posts/truncate"),
  ).toHaveLength(1);
});

test("sidebar search filters by name", async () => {
  const { user } = renderApp({ path: "/collections/hbc_posts" });
  const nav = await screen.findByRole("navigation", { name: "Collections" });
  await within(nav).findByRole("link", { name: "posts" });
  expect(within(nav).queryByRole("link", { name: "_superusers" })).toBeNull();
  await user.type(within(nav).getByLabelText("Search collections"), "us");
  expect(within(nav).getByRole("link", { name: "users" })).toBeTruthy();
  expect(within(nav).getByRole("link", { name: "_superusers" })).toBeTruthy();
  expect(within(nav).queryByRole("link", { name: "posts" })).toBeNull();
});

test("overview lists relation fields with their target collection", async () => {
  const { user } = renderApp({ path: "/collections/hbc_posts" });
  await user.click(await screen.findByRole("button", { name: "Overview" }));
  const dialog = screen.getByRole("dialog", { name: "Collections overview" });
  const row = within(dialog).getByRole("row", { name: /^posts/ });
  expect(row.textContent).toContain("author: users");
});

test("API preview shows the rule of each endpoint", async () => {
  const { user } = renderApp({ path: "/collections/hbc_posts" });
  await user.click(await screen.findByRole("button", { name: "API preview" }));
  const dialog = screen.getByRole("dialog", { name: "API preview" });
  const list = within(dialog).getByRole("row", { name: /^List\/Search/ });
  expect(list.textContent).toContain("/api/collections/posts/records");
  expect(list.textContent).toContain("Superusers only");
  expect(dialog.textContent).toContain('heybe.records("posts")');
});

test("API preview shows the client snippet highlighted and read-only", async () => {
  const { user } = renderApp({ path: "/collections/hbc_posts" });
  await user.click(await screen.findByRole("button", { name: "API preview" }));
  const dialog = screen.getByRole("dialog", { name: "API preview" });
  const code = within(dialog).getByLabelText("Client snippet");
  expect(code.querySelectorAll(".cm-line span").length).toBeGreaterThan(3);
  expect(code.textContent).toContain("createClient");
  expect(codeValue(code)).toContain('heybe.records("posts")');
  expect(dialog.querySelector(".cm-gutters")).toBeNull();
  expect(
    within(dialog).getByRole("button", { name: "Copy snippet" }),
  ).toBeTruthy();
});

test("saving refetches the records of the collection", async () => {
  const server = fakeServer()
    .on("GET", "/api/collections/:c/records", {
      page: 1,
      perPage: 40,
      totalItems: 0,
      totalPages: 1,
      items: [],
    })
    .on("PATCH", "/api/collections/:id", (req) => ({
      ...posts,
      ...(req.body as object),
    }));
  const { user, dialog } = await editPosts(server);
  await screen.findByText("Total: 0");
  const before = server.find("GET", "/api/collections/posts/records").length;
  expect(before).toBeGreaterThan(0);
  const title = within(fieldGroup("title")).getByLabelText("Field name");
  await user.clear(title);
  await user.type(title, "headline");
  await user.click(
    within(dialog).getByRole("button", { name: "Save changes" }),
  );
  await user.click(
    within(screen.getByRole("dialog", { name: "Confirm changes" })).getByRole(
      "button",
      { name: "Confirm" },
    ),
  );
  await screen.findByText("Collection saved.");
  expect(
    server.find("GET", "/api/collections/posts/records").length,
  ).toBeGreaterThan(before);
});

test("an unknown collection refetches the list once before showing not found", async () => {
  const server = fakeServer();
  const { router } = renderApp({ path: "/collections/hbc_nope", server });
  await screen.findByText("Collection not found");
  expect(server.find("GET", "/api/collections")).toHaveLength(2);
  expect(router.state.location.pathname).toBe("/collections/hbc_nope");
});

test("field card actions live in a menu", async () => {
  const { user } = await editPosts();
  const card = within(fieldGroup("title"));
  expect(card.queryByRole("button", { name: "Remove field" })).toBeNull();
  expect(card.queryByRole("button", { name: "Move up" })).toBeNull();
  await user.click(card.getByRole("button", { name: "Actions for title" }));
  expect(screen.getByRole("menuitem", { name: "Move up" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Move down" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Remove field" })).toBeTruthy();
});

test("create with empty name shows only the inline error", async () => {
  const items = [...collectionsFixture];
  const server = fakeServer()
    .on("GET", "/api/collections", () => ({
      page: 1,
      perPage: 1000,
      totalItems: items.length,
      totalPages: 1,
      items,
    }))
    .on("GET", "/api/collections/meta/scaffolds", scaffoldsFixture)
    .on(
      "POST",
      "/api/collections",
      {
        status: 400,
        message: "Failed to create collection.",
        data: {
          name: { code: "validation_required", message: "Cannot be blank." },
        },
      },
      400,
    );
  const { user } = renderApp({ path: "/collections/hbc_posts", server });
  await user.click(
    await screen.findByRole("button", { name: "New collection" }),
  );
  const dialog = screen.getByRole("dialog", { name: "New collection" });
  await within(dialog).findByLabelText("Name");
  await user.click(within(dialog).getByRole("button", { name: "Create" }));
  await within(dialog).findByText("Cannot be blank.");
  expect(within(dialog).queryByRole("alert")).toBeNull();
});

test("renaming a collection opened by name moves the URL to its id", async () => {
  const server = fakeServer().on("PATCH", "/api/collections/:id", (req) => ({
    ...posts,
    ...(req.body as object),
  }));
  const { user, router } = renderApp({ path: "/collections/posts", server });
  await user.click(
    await screen.findByRole("button", { name: "Edit collection posts" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Edit posts" });
  const name = within(dialog).getByLabelText("Name", { exact: true });
  await user.clear(name);
  await user.type(name, "articles");
  await user.click(
    within(dialog).getByRole("button", { name: "Save changes" }),
  );
  await user.click(
    within(screen.getByRole("dialog", { name: "Confirm changes" })).getByRole(
      "button",
      { name: "Confirm" },
    ),
  );
  await screen.findByText("Collection saved.");
  expect(router.state.location.pathname).toBe(`/collections/${posts.id}`);
});
