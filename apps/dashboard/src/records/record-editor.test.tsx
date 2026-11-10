import { expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import { fakeServer, type FakeServer } from "../test/fake-server";
import { renderApp } from "../test/render";

const saved = (extra: object = {}) => ({
  id: "r1",
  collectionId: "pbc_posts",
  collectionName: "posts",
  title: "Hello",
  views: 3,
  published: false,
  status: "draft",
  meta: { a: 1 },
  place: { lon: 0, lat: 0 },
  body: "<p>Hi</p>",
  created: "2026-01-01 00:00:00.000Z",
  updated: "2026-01-01 00:00:00.000Z",
  ...extra,
});

const open = (
  record: string,
  server: FakeServer = fakeServer(),
  c = "pbc_posts",
) => {
  server.on(
    "GET",
    `/api/collections/${c === "pbc_posts" ? "posts" : c}/records/:id`,
    saved(),
  );
  return renderApp({ path: `/collections/${c}?record=${record}`, server });
};

const dialog = async (name: string) => {
  await screen.findByRole("dialog", { name });
  await waitFor(() => expect(screen.queryByText("Loading...")).toBeNull());
  return within(screen.getByRole("dialog", { name }));
};

test("create posts filled fields with select multiple as an array and single as a string", async () => {
  const server = fakeServer().on(
    "POST",
    "/api/collections/posts/records",
    saved(),
  );
  const { user, router } = renderApp({
    path: "/collections/pbc_posts?record=new",
    server,
  });
  const d = await dialog("New record");
  await user.type(d.getByLabelText("title"), "Hello");
  await user.selectOptions(d.getByLabelText("status"), "live");
  await user.type(d.getByLabelText("views"), "5");
  await user.click(d.getByLabelText("published"));
  await user.click(d.getByRole("button", { name: "Save" }));
  await screen.findByText("Record saved.");
  expect(
    server.find("POST", "/api/collections/posts/records")[0]!.body,
  ).toEqual({
    title: "Hello",
    status: "live",
    views: 5,
    published: true,
  });
  expect(router.state.location.search).not.toHaveProperty("record");
});

test("multi select sends an array", async () => {
  const server = fakeServer().on("POST", "/api/collections/tags/records", {});
  const { collectionsFixture } = await import("../test/fixtures");
  const { serveCollections } = await import("../test/editor");
  const tags = {
    ...collectionsFixture[0]!,
    id: "pbc_tags",
    name: "tags",
    fields: [
      collectionsFixture[0]!.fields[0]!,
      {
        id: "s1",
        name: "kinds",
        type: "select",
        system: false,
        hidden: false,
        presentable: false,
        required: false,
        values: ["a", "b", "c"],
        maxSelect: 3,
      },
    ],
  };
  serveCollections(server, [tags]);
  const { user } = renderApp({
    path: "/collections/pbc_tags?record=new",
    server,
  });
  const d = await dialog("New record");
  await user.click(d.getByLabelText("a"));
  await user.click(d.getByLabelText("c"));
  await user.click(d.getByRole("button", { name: "Save" }));
  await screen.findByText("Record saved.");
  expect(server.find("POST", "/api/collections/tags/records")[0]!.body).toEqual(
    {
      kinds: ["a", "c"],
    },
  );
});

test("update sends only the changed keys", async () => {
  const server = fakeServer().on(
    "PATCH",
    "/api/collections/posts/records/:id",
    saved(),
  );
  const { user } = open("r1", server);
  const d = await dialog("Edit record");
  const title = await d.findByLabelText("title");
  await user.clear(title);
  await user.type(title, "Changed");
  await user.click(d.getByRole("button", { name: "Save" }));
  await screen.findByText("Record saved.");
  expect(
    server.find("PATCH", "/api/collections/posts/records/:id")[0]!.body,
  ).toEqual({
    title: "Changed",
  });
});

test('invalid JSON blocks submit with "Invalid JSON." under the input and sends nothing', async () => {
  const server = fakeServer();
  const { user } = open("r1", server);
  const d = await dialog("Edit record");
  const meta = await d.findByLabelText("meta");
  await user.clear(meta);
  await user.type(meta, "{{oops");
  await user.click(d.getByRole("button", { name: "Save" }));
  const message = await d.findByText("Invalid JSON.");
  expect(meta.getAttribute("aria-describedby")).toBe(message.id);
  expect(
    server.find("PATCH", "/api/collections/posts/records/:id"),
  ).toHaveLength(0);
});

test("geoPoint sends {lon, lat} numbers", async () => {
  const server = fakeServer().on(
    "POST",
    "/api/collections/posts/records",
    saved(),
  );
  const { user } = renderApp({
    path: "/collections/pbc_posts?record=new",
    server,
  });
  const d = await dialog("New record");
  await user.type(d.getByLabelText("Longitude"), "12.5");
  await user.type(d.getByLabelText("Latitude"), "-40");
  await user.click(d.getByRole("button", { name: "Save" }));
  await screen.findByText("Record saved.");
  expect(
    server.find("POST", "/api/collections/posts/records")[0]!.body,
  ).toEqual({
    place: { lon: 12.5, lat: -40 },
  });
});

test("date is edited in UTC and sent in the server format", async () => {
  const server = fakeServer().on(
    "POST",
    "/api/collections/posts/records",
    saved(),
  );
  const { user } = renderApp({
    path: "/collections/pbc_posts?record=new",
    server,
  });
  const d = await dialog("New record");
  expect(d.getByText("when (UTC)")).toBeTruthy();
  await user.type(d.getByLabelText("when (UTC)"), "2026-11-11T10:20:30");
  await user.click(d.getByRole("button", { name: "Save" }));
  await screen.findByText("Record saved.");
  expect(
    server.find("POST", "/api/collections/posts/records")[0]!.body,
  ).toEqual({
    when: "2026-11-11 10:20:30.000Z",
  });
});

test("password is sent only when Change password is checked", async () => {
  const server = fakeServer()
    .on("GET", "/api/collections/users/records/:id", {
      id: "u1",
      collectionId: "_pb_users_auth_",
      collectionName: "users",
      email: "a@b.c",
      emailVisibility: false,
      verified: true,
    })
    .on("PATCH", "/api/collections/users/records/:id", {});
  const { user } = renderApp({
    path: "/collections/_pb_users_auth_?record=u1",
    server,
  });
  const d = await dialog("Edit record");
  expect(await d.findByLabelText("Email")).toBeTruthy();
  expect(d.getByLabelText("Public email")).toBeTruthy();
  expect(d.getByLabelText("Verified")).toBeTruthy();
  expect(d.queryByLabelText("Password")).toBeNull();
  await user.click(d.getByLabelText("Change password"));
  await user.type(d.getByLabelText("Password"), "secret123");
  await user.type(d.getByLabelText("Confirm password"), "secret123");
  await user.click(d.getByRole("button", { name: "Save" }));
  await screen.findByText("Record saved.");
  expect(
    server.find("PATCH", "/api/collections/users/records/:id")[0]!.body,
  ).toEqual({
    password: "secret123",
    passwordConfirm: "secret123",
  });
});

test("an untouched password is not sent", async () => {
  const server = fakeServer()
    .on("GET", "/api/collections/users/records/:id", {
      id: "u1",
      collectionId: "_pb_users_auth_",
      collectionName: "users",
      email: "a@b.c",
    })
    .on("PATCH", "/api/collections/users/records/:id", {});
  const { user } = renderApp({
    path: "/collections/_pb_users_auth_?record=u1",
    server,
  });
  const d = await dialog("Edit record");
  await user.click(await d.findByLabelText("Verified"));
  await user.click(d.getByRole("button", { name: "Save" }));
  await screen.findByText("Record saved.");
  expect(
    server.find("PATCH", "/api/collections/users/records/:id")[0]!.body,
  ).toEqual({
    verified: true,
  });
});

test("server errors map to inputs", async () => {
  const server = fakeServer().on(
    "POST",
    "/api/collections/posts/records",
    {
      code: 400,
      message: "Failed to create record.",
      data: {
        title: { code: "validation_required", message: "Cannot be blank." },
        other: { message: "Odd." },
      },
    },
    400,
  );
  const { user } = renderApp({
    path: "/collections/pbc_posts?record=new",
    server,
  });
  const d = await dialog("New record");
  await user.click(d.getByRole("button", { name: "Save" }));
  const message = await d.findByText("Cannot be blank.");
  expect(d.getByLabelText("title").getAttribute("aria-describedby")).toBe(
    message.id,
  );
  expect(d.getByText("other: Odd.")).toBeTruthy();
});

test("editor preview is a sandboxed iframe with the HTML in srcdoc", async () => {
  const { user } = open("r1");
  const d = await dialog("Edit record");
  await user.click(await d.findByRole("button", { name: "Preview" }));
  const frame = d.getByTitle("body preview");
  expect(frame.getAttribute("sandbox")).toBe("");
  expect(frame.getAttribute("srcdoc")).toBe("<p>Hi</p>");
});

test("a script value in a text field stays text in the input", async () => {
  const hostile = "<script>alert(1)</script><img src=x onerror=alert(2)>";
  const server = fakeServer().on(
    "GET",
    "/api/collections/posts/records/:id",
    saved({ title: hostile }),
  );
  renderApp({ path: "/collections/pbc_posts?record=r1", server });
  const d = await dialog("Edit record");
  const input = (await d.findByLabelText("title")) as HTMLInputElement;
  expect(input.value).toBe(hostile);
  expect(document.querySelector("script, img[src=x]")).toBeNull();
});

test("closing a dirty editor asks to discard", async () => {
  const { user, router } = open("r1");
  const d = await dialog("Edit record");
  await user.type(await d.findByLabelText("title"), "x");
  await user.click(d.getByRole("button", { name: "Cancel" }));
  const confirm = await screen.findByRole("dialog", {
    name: "Discard unsaved changes?",
  });
  await user.click(
    within(confirm).getByRole("button", { name: "Keep editing" }),
  );
  expect(router.state.location.search).toMatchObject({ record: "r1" });
  await user.click(d.getByRole("button", { name: "Cancel" }));
  await user.click(
    within(
      await screen.findByRole("dialog", { name: "Discard unsaved changes?" }),
    ).getByRole("button", { name: "Discard" }),
  );
  expect(router.state.location.search).not.toHaveProperty("record");
});

test("closing a clean editor does not ask", async () => {
  const { user, router } = open("r1");
  const d = await dialog("Edit record");
  await d.findByLabelText("title");
  await user.click(d.getByRole("button", { name: "Cancel" }));
  expect(router.state.location.search).not.toHaveProperty("record");
});

test("view collection records open read-only", async () => {
  const server = fakeServer().on("GET", "/api/collections/stats/records/:id", {
    id: "v1",
    collectionId: "pbc_stats",
    collectionName: "stats",
    title: "T",
  });
  renderApp({ path: "/collections/pbc_stats?record=v1", server });
  const d = await dialog("Record");
  const title = (await d.findByLabelText("title")) as HTMLInputElement;
  expect(title.disabled).toBe(true);
  expect(d.queryByRole("button", { name: "Save" })).toBeNull();
  expect(d.queryByRole("button", { name: "Delete" })).toBeNull();
});

test("Duplicate opens a new record without id", async () => {
  const { user, router } = open("r1");
  const d = await dialog("Edit record");
  await d.findByLabelText("title");
  await user.click(d.getByRole("button", { name: "Duplicate" }));
  const next = await dialog("New record");
  expect(router.state.location.search).toMatchObject({ record: "new" });
  expect(
    ((await next.findByLabelText("title")) as HTMLInputElement).value,
  ).toBe("Hello");
  expect((next.getByLabelText("id") as HTMLInputElement).value).toBe("");
});

test("Delete confirms, deletes and closes", async () => {
  const server = fakeServer().on(
    "DELETE",
    "/api/collections/posts/records/:id",
    () => undefined,
    204,
  );
  const { user, router } = open("r1", server);
  const d = await dialog("Edit record");
  await d.findByLabelText("title");
  await user.click(d.getByRole("button", { name: "Delete" }));
  const confirm = await screen.findByRole("dialog", { name: "Delete record" });
  await user.click(within(confirm).getByRole("button", { name: "Delete" }));
  await screen.findByText("Record deleted.");
  expect(
    server.find("DELETE", "/api/collections/posts/records/:id"),
  ).toHaveLength(1);
  expect(router.state.location.search).not.toHaveProperty("record");
});

test("a 404 record id shows the server message", async () => {
  const server = fakeServer().on(
    "GET",
    "/api/collections/posts/records/:id",
    { code: 404, message: "The requested resource wasn't found.", data: {} },
    404,
  );
  renderApp({ path: "/collections/pbc_posts?record=nope", server });
  const d = await dialog("Edit record");
  expect(
    await d.findByText("The requested resource wasn't found."),
  ).toBeTruthy();
  expect(d.queryByRole("button", { name: "Save" })).toBeNull();
});

test("a view record keeps the editor preview usable", async () => {
  const { collectionsFixture } = await import("../test/fixtures");
  const { serveCollections } = await import("../test/editor");
  const stats = collectionsFixture.find((c) => c.name === "stats")!;
  const view = {
    ...stats,
    fields: [
      ...stats.fields,
      {
        ...collectionsFixture[0]!.fields.find((f) => f.name === "body")!,
        id: "e1",
      },
    ],
  };
  const server = serveCollections(fakeServer(), [view]).on(
    "GET",
    "/api/collections/stats/records/:id",
    {
      id: "v1",
      collectionName: "stats",
      collectionId: "pbc_stats",
      title: "T",
      body: "<p>x</p>",
    },
  );
  const { user } = renderApp({
    path: "/collections/pbc_stats?record=v1",
    server,
  });
  const d = await dialog("Record");
  const preview = await d.findByRole("button", { name: "Preview" });
  expect((preview as HTMLButtonElement).disabled).toBe(false);
  await user.click(preview);
  expect(d.getByTitle("body preview").getAttribute("srcdoc")).toBe("<p>x</p>");
});

test("Duplicate on a dirty form asks before leaving", async () => {
  const { user, router } = open("r1");
  const d = await dialog("Edit record");
  await user.type(await d.findByLabelText("title"), "x");
  await user.click(d.getByRole("button", { name: "Duplicate" }));
  const confirm = await screen.findByRole("dialog", {
    name: "Discard unsaved changes?",
  });
  await user.click(
    within(confirm).getByRole("button", { name: "Keep editing" }),
  );
  expect(router.state.location.search).toMatchObject({ record: "r1" });
});

test("a local JSON error replaces a stale server error", async () => {
  const server = fakeServer().on(
    "PATCH",
    "/api/collections/posts/records/:id",
    {
      code: 400,
      message: "Failed to update record.",
      data: { title: { message: "Too long." } },
    },
    400,
  );
  const { user } = open("r1", server);
  const d = await dialog("Edit record");
  const title = await d.findByLabelText("title");
  await user.type(title, "x");
  await user.click(d.getByRole("button", { name: "Save" }));
  await d.findByText("Too long.");
  const meta = d.getByLabelText("meta");
  await user.clear(meta);
  await user.type(meta, "{{oops");
  await user.click(d.getByRole("button", { name: "Save" }));
  await d.findByText("Invalid JSON.");
  expect(d.queryByText("Too long.")).toBeNull();
});

test("geoPoint and multi select errors are linked to their inputs", async () => {
  const server = fakeServer().on(
    "POST",
    "/api/collections/posts/records",
    {
      code: 400,
      message: "Failed.",
      data: { place: { message: "Bad point." } },
    },
    400,
  );
  const { user } = renderApp({
    path: "/collections/pbc_posts?record=new",
    server,
  });
  const d = await dialog("New record");
  await user.click(d.getByRole("button", { name: "Save" }));
  const message = await d.findByText("Bad point.");
  for (const label of ["Longitude", "Latitude"])
    expect(d.getByLabelText(label).getAttribute("aria-describedby")).toBe(
      message.id,
    );
});
