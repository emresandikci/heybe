import { expect, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { fakeServer } from "../test/fake-server";
import { setCode } from "../test/editor";
import { renderApp } from "../test/render";
import {
  docRecord,
  docsServer,
  openActions,
  pickAction,
} from "./editor-fixtures";

const record = (id: string, extra: object = {}) => ({
  id,
  collectionId: "hbc_posts",
  collectionName: "posts",
  title: `Post ${id}`,
  created: "2026-01-01 00:00:00.000Z",
  updated: "2026-01-01 00:00:00.000Z",
  ...extra,
});

const serve = (items: object[] = [record("a"), record("b")], pages = 1) =>
  fakeServer().on("GET", "/api/collections/:c/records", {
    page: 1,
    perPage: 40,
    totalItems: items.length,
    totalPages: pages,
    items,
  });

const drawer = async (name: string) => {
  await screen.findByRole("dialog", { name });
  await waitFor(() => expect(screen.queryByText("Loading...")).toBeNull());
  return within(screen.getByRole("dialog", { name }));
};

const applyFilter = async (
  user: { keyboard: (keys: string) => Promise<void> },
  text: string,
) => {
  const input = await screen.findByLabelText("Filter records");
  setCode(input, text);
  input.focus();
  await user.keyboard("{Enter}");
  return input;
};

test("selected rows get the selected background", async () => {
  const { user } = renderApp({
    path: "/collections/hbc_posts",
    server: serve(),
  });
  await screen.findByText("Post a");
  const row = screen.getByText("Post a").closest("tr")!;
  expect(row.hasAttribute("data-selected")).toBe(false);
  await user.click(screen.getByRole("checkbox", { name: "Select Post a" }));
  expect(row.hasAttribute("data-selected")).toBe(true);
});

test("long text cells truncate with the full value as title", async () => {
  const long = `Post ${"x".repeat(80)}`;
  renderApp({
    path: "/collections/hbc_posts",
    server: serve([record("a", { title: long })]),
  });
  const cell = (await screen.findByText(long)).closest("td")!;
  expect(cell.className).toContain("truncate");
  expect(cell.getAttribute("title")).toBe(long);
});

test("view collections have no row selection", async () => {
  const server = serve([
    {
      id: "v1",
      collectionName: "stats",
      collectionId: "hbc_stats",
      title: "T",
    },
  ]);
  renderApp({ path: "/collections/hbc_stats", server });
  await screen.findByText("T");
  expect(screen.queryByRole("checkbox")).toBeNull();
});

test("pagination hidden with one page and shown with several", async () => {
  renderApp({ path: "/collections/hbc_posts", server: serve() });
  await screen.findByText("Post a");
  expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
});

test("pagination shows with several pages", async () => {
  renderApp({ path: "/collections/hbc_posts", server: serve(undefined, 3) });
  await screen.findByText("Post a");
  expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
});

test("the page title is the crumb and the footer shows the total", async () => {
  renderApp({ path: "/collections/hbc_posts", server: serve() });
  await screen.findByText("Post a");
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "Collections / posts",
  );
  expect(screen.getByText("Total: 2")).toBeTruthy();
});

test("Clear is disabled when the filter is empty", async () => {
  const { user } = renderApp({
    path: "/collections/hbc_posts",
    server: serve(),
  });
  await screen.findByText("Post a");
  const clear = screen.getByRole("button", {
    name: "Clear",
  }) as HTMLButtonElement;
  expect(clear.disabled).toBe(true);
  await applyFilter(user, "title ~ x");
  await waitFor(() => expect(clear.disabled).toBe(false));
});

test("invalid filter shows the filter error, not a text search", async () => {
  const server = fakeServer();
  let fail = false;
  server.on("GET", "/api/collections/:c/records", () => {
    if (fail)
      return Response.json(
        { code: 400, message: "Invalid filter.", data: {} },
        { status: 400 },
      );
    return { page: 1, perPage: 40, totalItems: 0, totalPages: 1, items: [] };
  });
  const { user } = renderApp({ path: "/collections/hbc_posts", server });
  await screen.findByText("No records yet");
  fail = true;
  await applyFilter(user, "bad((");
  await screen.findByText("Invalid filter. Check the syntax and field names.");
  expect(
    server
      .find("GET", "/api/collections/posts/records")
      .at(-1)!
      .query.get("filter"),
  ).toBe("bad((");
});

test("typing a field prefix offers the field and Enter applies the filter", async () => {
  const server = serve();
  const { user, router } = renderApp({
    path: "/collections/hbc_posts",
    server,
  });
  const input = await screen.findByLabelText("Filter records");
  const view = EditorView.findFromDOM(input)!;
  input.focus();
  act(() =>
    view.dispatch({
      changes: { from: 0, insert: "tit" },
      selection: { anchor: 3 },
      userEvent: "input.type",
    }),
  );
  await waitFor(() => {
    const tip = document.querySelector(".cm-tooltip-autocomplete");
    expect(tip?.textContent).toContain("title");
  });
  setCode(input, 'title = "a"');
  input.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(router.state.location.search).toMatchObject({
      filter: 'title = "a"',
    }),
  );
});

test("drawer secondary actions are in More actions and Delete confirms", async () => {
  const server = fakeServer()
    .on("GET", "/api/collections/posts/records/:id", record("r1"))
    .on("DELETE", "/api/collections/posts/records/:id", () => undefined);
  const { user } = renderApp({
    path: "/collections/hbc_posts?record=r1",
    server,
  });
  const d = await drawer("Edit record");
  expect(d.queryByRole("button", { name: "Duplicate" })).toBeNull();
  expect(d.queryByRole("button", { name: "Delete" })).toBeNull();
  const menu = await openActions(user, d);
  expect(menu.getByRole("menuitem", { name: "Duplicate" })).toBeTruthy();
  expect(menu.getByRole("menuitem", { name: "Copy JSON" })).toBeTruthy();
  await user.click(menu.getByRole("menuitem", { name: "Delete" }));
  const confirm = await screen.findByRole("dialog", { name: "Delete record" });
  await user.click(within(confirm).getByRole("button", { name: "Delete" }));
  await screen.findByText("Record deleted.");
});

test("submit error focuses the first invalid field", async () => {
  const server = fakeServer()
    .on("GET", "/api/collections/posts/records/:id", record("r1"))
    .on(
      "PATCH",
      "/api/collections/posts/records/:id",
      {
        code: 400,
        message: "Failed to update record.",
        data: { views: { message: "Too big." } },
      },
      400,
    );
  const { user } = renderApp({
    path: "/collections/hbc_posts?record=r1",
    server,
  });
  const d = await drawer("Edit record");
  await user.type(d.getByLabelText("title"), "x");
  await user.click(d.getByRole("button", { name: "Save changes" }));
  await d.findByText("Too big.");
  await waitFor(() =>
    expect(document.activeElement).toBe(d.getByLabelText("views")),
  );
});

test("relation chips show the display field and a labeled remove button", async () => {
  const server = docsServer().on(
    "GET",
    "/api/collections/docs/records/:id",
    docRecord({
      owner: "u1",
      expand: { owner: { id: "u1", collectionName: "users", name: "Ada" } },
    }),
  );
  renderApp({ path: "/collections/hbc_docs?record=d1", server });
  const owner = within(await screen.findByRole("group", { name: "owner" }));
  const remove = await owner.findByRole("button", { name: "Remove Ada" });
  expect(remove.textContent).toBe("");
  expect(remove.querySelector("svg")).toBeTruthy();
  expect(owner.getByText("Ada")).toBeTruthy();
});

test("single file field shows file name with a Remove button labeled Remove <name>", async () => {
  const server = docsServer().on(
    "GET",
    "/api/collections/docs/records/:id",
    docRecord({ cover: "report.pdf" }),
  );
  renderApp({ path: "/collections/hbc_docs?record=d1", server });
  const cover = within(await screen.findByRole("group", { name: "cover" }));
  expect(cover.getByText("report.pdf")).toBeTruthy();
  const remove = await cover.findByRole("button", {
    name: "Remove report.pdf",
  });
  expect(remove.textContent).toBe("Remove");
});

test("geo point inputs render side by side in one group", async () => {
  renderApp({
    path: "/collections/hbc_posts?record=new",
    server: serve(),
  });
  const geo = within(await screen.findByRole("group", { name: "place" }));
  const lon = geo.getByLabelText("Longitude");
  const lat = geo.getByLabelText("Latitude");
  expect(lon.closest(".grid")).toBe(lat.closest(".grid"));
  expect(lon.closest(".grid")!.className).toContain("grid-cols-2");
});

test("API preview dialog is wide and rows have equal height", async () => {
  const { user } = renderApp({
    path: "/collections/hbc_posts",
    server: serve(),
  });
  await user.click(await screen.findByRole("button", { name: "API preview" }));
  const dialog = screen.getByRole("dialog", { name: "API preview" });
  expect(dialog.className).toContain("max-w-3xl");
  const rows = within(dialog).getAllByRole("row").slice(1);
  expect(rows.length).toBeGreaterThan(1);
  for (const row of rows) expect(row.className).toContain("h-11");
});

test("right edge shadow is present on load when the table overflows", async () => {
  const sizes = { scrollWidth: 2000, clientWidth: 500 };
  for (const [key, value] of Object.entries(sizes))
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get: () => value,
    });
  try {
    renderApp({ path: "/collections/hbc_posts", server: serve() });
    await screen.findByText("Post a");
    const right = document.querySelector("[data-edge=right]")!;
    const left = document.querySelector("[data-edge=left]")!;
    await waitFor(() => expect(right.className).toContain("opacity-100"));
    expect(left.className).toContain("opacity-0");
  } finally {
    for (const key of Object.keys(sizes))
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
});

test("impersonating does not save the record", async () => {
  const server = fakeServer()
    .on("GET", "/api/collections/users/records/:id", {
      id: "u1",
      collectionId: "_hb_users_auth_",
      collectionName: "users",
      email: "a@b.c",
      verified: true,
    })
    .on("PATCH", "/api/collections/users/records/:id", {})
    .on("POST", "/api/collections/users/impersonate/:id", {
      token: "t",
      record: { id: "u1" },
    });
  const { user } = renderApp({
    path: "/collections/_hb_users_auth_?record=u1",
    server,
  });
  const d = await drawer("Edit record");
  await pickAction(user, d, "Impersonate");
  const dialog = within(
    await screen.findByRole("dialog", { name: "Impersonate a@b.c" }),
  );
  await user.click(dialog.getByRole("button", { name: "Generate token" }));
  await dialog.findByLabelText("Token");
  expect(
    server.find("PATCH", "/api/collections/users/records/:id"),
  ).toHaveLength(0);
});
