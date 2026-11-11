import { expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { fakeServer, type FakeServer } from "../test/fake-server";
import { serveCollections } from "../test/editor";
import { collectionsFixture } from "../test/fixtures";
import { renderApp } from "../test/render";
import { validateRecordsSearch } from "./RecordsPage";

const record = (id: string, extra: object = {}) => ({
  id,
  collectionId: "pbc_posts",
  collectionName: "posts",
  title: `Post ${id}`,
  created: "2026-01-01 00:00:00.000Z",
  updated: "2026-01-01 00:00:00.000Z",
  ...extra,
});

function serve(
  items: object[] = [record("a"), record("b")],
  server: FakeServer = fakeServer(),
) {
  return server.on("GET", "/api/collections/:c/records", (req) => ({
    page: Number(req.query.get("page") ?? 1),
    perPage: 40,
    totalItems: items.length,
    totalPages: 1,
    items,
  }));
}

const open = (server: FakeServer, path = "/collections/pbc_posts") =>
  renderApp({ path, server });

test("list requests page 1, perPage 40, sort -@rowid and the relation expand", async () => {
  const server = serve();
  open(server);
  await screen.findByText("Post a");
  const [req] = server.find("GET", "/api/collections/posts/records");
  expect(req!.query.get("page")).toBe("1");
  expect(req!.query.get("perPage")).toBe("40");
  expect(req!.query.get("sort")).toBe("-@rowid");
  expect(req!.query.get("expand")).toBe("author");
  expect(screen.getByText("2 records")).toBeTruthy();
});

test("view collection: no default sort and no New record", async () => {
  const server = serve([
    {
      id: "v1",
      collectionName: "stats",
      collectionId: "pbc_stats",
      title: "T",
    },
  ]);
  open(server, "/collections/pbc_stats");
  await screen.findByText("T");
  const [req] = server.find("GET", "/api/collections/stats/records");
  expect(req!.query.has("sort")).toBe(false);
  expect(screen.queryByRole("button", { name: "New record" })).toBeNull();
});

test("Enter in the filter sends it raw and writes ?filter=", async () => {
  const server = serve();
  const { user, router } = open(server);
  const input = await screen.findByLabelText("Filter records");
  await user.type(input, 'title ~ "a b" && views > 1{Enter}');
  await screen.findByText("Post a");
  expect(router.state.location.search).toMatchObject({
    filter: 'title ~ "a b" && views > 1',
  });
  const reqs = server.find("GET", "/api/collections/posts/records");
  expect(reqs.at(-1)!.query.get("filter")).toBe('title ~ "a b" && views > 1');
  expect(reqs.at(-1)!.query.get("page")).toBe("1");
});

test("a column header cycles sort and sets aria-sort", async () => {
  const server = serve();
  const { user } = open(server);
  await screen.findByText("Post a");
  const header = () => screen.getByRole("columnheader", { name: "title" });
  expect(header().getAttribute("aria-sort")).toBe("none");
  await user.click(within(header()).getByRole("button"));
  expect(header().getAttribute("aria-sort")).toBe("ascending");
  await user.click(within(header()).getByRole("button"));
  expect(header().getAttribute("aria-sort")).toBe("descending");
  const sorts = () =>
    server
      .find("GET", "/api/collections/posts/records")
      .map((r) => r.query.get("sort"));
  expect(sorts()).toContain("title");
  expect(sorts()).toContain("-title");
  await user.click(within(header()).getByRole("button"));
  expect(header().getAttribute("aria-sort")).toBe("none");
  expect(sorts().at(-1)).toBe("-@rowid");
});

test("a value with <img src=x onerror=alert(1)> renders as text", async () => {
  const hostile = "<img src=x onerror=alert(1)>";
  open(serve([record("a", { title: hostile })]));
  const cell = await screen.findByText(hostile);
  expect(cell.querySelector("img")).toBeNull();
  expect(document.querySelector("img[src=x]")).toBeNull();
});

test("100 KB json renders 100 characters", async () => {
  const meta = { blob: "z".repeat(100_000) };
  open(serve([record("a", { meta })]));
  await screen.findByText("Post a");
  const row = screen.getByRole("row", { name: /Post a/ });
  const text = JSON.stringify(meta).slice(0, 100);
  expect(within(row).getByText(text)).toBeTruthy();
});

test("bulk delete deletes each selected id after confirmation", async () => {
  const server = serve([record("a"), record("b"), record("c")]).on(
    "DELETE",
    "/api/collections/posts/records/:id",
    () => undefined,
    204,
  );
  const { user } = open(server);
  await screen.findByText("Post a");
  await user.click(screen.getByRole("checkbox", { name: "Select Post a" }));
  await user.click(screen.getByRole("checkbox", { name: "Select Post c" }));
  await user.click(screen.getByRole("button", { name: "Delete selected (2)" }));
  expect(
    server.find("DELETE", "/api/collections/posts/records/:id"),
  ).toHaveLength(0);
  const dialog = screen.getByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Delete" }));
  await screen.findByText("Post b");
  const deleted = server
    .find("DELETE", "/api/collections/posts/records/:id")
    .map((r) => r.path.split("/").at(-1))
    .sort();
  expect(deleted).toEqual(["a", "c"]);
  expect(server.find("GET", "/api/collections/posts/records")).toHaveLength(2);
});

test("hidden columns persist per collection", async () => {
  const server = serve();
  const { user } = open(server);
  await screen.findByText("Post a");
  await user.click(screen.getByRole("button", { name: "Columns" }));
  await user.click(screen.getByRole("checkbox", { name: "views" }));
  expect(screen.queryByRole("columnheader", { name: "views" })).toBeNull();
  expect(screen.getByRole("columnheader", { name: "title" })).toBeTruthy();
  expect(JSON.parse(localStorage.getItem("heybe_columns_pbc_posts")!)).toEqual([
    "views",
  ]);
});

test("stored hidden columns apply on load", async () => {
  localStorage.setItem("heybe_columns_pbc_posts", JSON.stringify(["title"]));
  open(serve());
  await screen.findByRole("columnheader", { name: "views" });
  expect(screen.queryByRole("columnheader", { name: "title" })).toBeNull();
});

test("a filter 400 shows the message under the search", async () => {
  const server = fakeServer().on(
    "GET",
    "/api/collections/:c/records",
    {
      code: 400,
      message: "Something went wrong while processing your request.",
      data: {},
    },
    400,
  );
  const { user } = open(server);
  await user.type(
    await screen.findByLabelText("Filter records"),
    "nope{Enter}",
  );
  const input = await screen.findByLabelText("Filter records");
  const message = await screen.findByText(
    "Something went wrong while processing your request.",
  );
  expect(input.getAttribute("aria-describedby")).toBe(message.id);
});

test("recent filters keep the last 10", async () => {
  const { user } = open(serve());
  const input = await screen.findByLabelText("Filter records");
  for (let i = 1; i <= 11; i++) {
    await user.clear(input);
    await user.type(input, `views > ${i}{Enter}`);
  }
  expect(
    JSON.parse(localStorage.getItem("heybe_filter_history")!),
  ).toHaveLength(10);
  await user.click(screen.getByRole("button", { name: "Recent filters" }));
  const menu = screen.getByRole("list", { name: "Recent filters" });
  const items = within(menu).getAllByRole("button");
  expect(items).toHaveLength(10);
  expect(items[0]!.textContent).toBe("views > 11");
  expect(within(menu).queryByText("views > 1")).toBeNull();
  await user.click(items[1]!);
  expect((input as HTMLInputElement).value).toBe("views > 10");
});

test("New record and row click open ?record=", async () => {
  const { user, router } = open(
    serve().on("GET", "/api/collections/posts/records/:id", record("b")),
  );
  await user.click(await screen.findByRole("button", { name: "New record" }));
  expect(router.state.location.search).toMatchObject({ record: "new" });
  await user.click(screen.getByText("Post b"));
  expect(router.state.location.search).toMatchObject({ record: "b" });
});

test("sorting clears the selection", async () => {
  const { user } = open(serve());
  await screen.findByText("Post a");
  await user.click(screen.getByRole("checkbox", { name: "Select Post a" }));
  const header = screen.getByRole("columnheader", { name: "title" });
  await user.click(within(header).getByRole("button"));
  expect(screen.queryByRole("button", { name: /Delete selected/ })).toBeNull();
});

const searchFilter = async (text: string) => {
  const server = serve();
  const { user } = open(server);
  await user.type(
    await screen.findByLabelText("Filter records"),
    `${text}{Enter}`,
  );
  await screen.findByText("Post a");
  return server
    .find("GET", "/api/collections/posts/records")
    .at(-1)!
    .query.get("filter");
};

test("plain text searches id and the visible fields", async () => {
  const filter = await searchFilter("john");
  expect(filter!.split("||")).toEqual(
    expect.arrayContaining(['id?~"john"', 'title?~"john"', 'views?~"john"']),
  );
  expect(filter).not.toContain("tokenKey");
});

test("plain text with a quote or backslash is escaped", async () => {
  const filter = await searchFilter('a"b\\c');
  expect(filter).toContain('title?~"a\\"b\\\\c"');
});

test("an expression stays raw", async () => {
  expect(await searchFilter("views > 3")).toBe("views > 3");
});

test("validateRecordsSearch drops invalid pages", () => {
  for (const page of [0, 1.5, "abc", -2])
    expect(validateRecordsSearch({ page })).toEqual({});
  expect(validateRecordsSearch({ page: "3", record: "x" })).toEqual({
    page: 3,
    record: "x",
  });
});

test("a <script> value renders as text", async () => {
  const hostile = "<script>alert(1)</script>";
  open(serve([record("a", { title: hostile })]));
  const cell = await screen.findByText(hostile);
  expect(cell.querySelector("script")).toBeNull();
});

const withCover = (protectedFile: boolean) => {
  const items = collectionsFixture.map((c) =>
    c.name === "posts"
      ? {
          ...c,
          fields: c.fields.map((f) =>
            f.name === "cover" ? { ...f, protected: protectedFile } : f,
          ),
        }
      : c,
  );
  return serveCollections(fakeServer(), items);
};

test("file thumbs encode unicode, spaces and underscores", async () => {
  const server = serve(
    [record("a", { cover: "my cat_\u00e7.png" })],
    withCover(false),
  );
  open(server);
  const img = (await screen.findByAltText(
    "my cat_\u00e7.png",
  )) as HTMLImageElement;
  expect(img.getAttribute("src")).toContain("/my%20cat_%C3%A7.png");
  expect(img.getAttribute("src")).toContain("thumb=100x100");
});

test("protected file thumbs carry the file token", async () => {
  const server = serve([record("a", { cover: "cat.png" })], withCover(true)).on(
    "POST",
    "/api/files/token",
    { token: "ft1" },
  );
  open(server);
  const img = await screen.findByAltText("cat.png");
  expect(img.getAttribute("src")).toContain("token=ft1");
});

test("relation cells show presentable labels from expand", async () => {
  const items = collectionsFixture.map((c) =>
    c.name === "users"
      ? {
          ...c,
          fields: c.fields.map((f) =>
            f.name === "name" ? { ...f, presentable: true } : f,
          ),
        }
      : c,
  );
  const server = serve(
    [
      record("a", {
        author: "u1",
        expand: { author: { id: "u1", name: "Ada" } },
      }),
    ],
    serveCollections(fakeServer(), items),
  );
  open(server);
  expect(await screen.findByText("Ada")).toBeTruthy();
});

test("Space on a focused row opens the record", async () => {
  const server = serve().on(
    "GET",
    "/api/collections/:c/records/:id",
    record("a"),
  );
  const { user, router } = open(server);
  const row = (await screen.findByText("Post a")).closest("tr")!;
  row.focus();
  await user.keyboard(" ");
  expect(router.state.location.search).toMatchObject({ record: "a" });
});
