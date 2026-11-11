import { afterEach, expect, spyOn, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { paste } from "../test/editor";
import { fakeServer } from "../test/fake-server";
import { collectionsFixture, settingsFixture } from "../test/fixtures";
import { renderApp } from "../test/render";
import { exportJson } from "./import-diff";

const posts = collectionsFixture.find((c) => c.name === "posts")!;

async function openExport() {
  const app = renderApp({ path: "/settings/export-collections" });
  await screen.findByRole("checkbox", { name: "posts" });
  return app;
}

async function openImport(server = fakeServer()) {
  const app = renderApp({ path: "/settings/import-collections", server });
  await screen.findByLabelText("Collections JSON");
  return app;
}

const restores: (() => void)[] = [];
afterEach(() => restores.splice(0).forEach((restore) => restore()));

test("export JSON has no created or updated", async () => {
  await openExport();
  const preview = screen.getByLabelText("Export preview").textContent!;
  const items = JSON.parse(preview) as Record<string, unknown>[];
  expect(items.map((c) => c.name)).toEqual([
    "posts",
    "stats",
    "_superusers",
    "users",
  ]);
  expect(items.some((c) => "created" in c || "updated" in c)).toBe(false);
});

test("export selection narrows the preview and Select all toggles", async () => {
  const { user } = await openExport();
  await user.click(screen.getByRole("checkbox", { name: "Select all" }));
  expect(screen.getByLabelText("Export preview").textContent).toBe("[]");
  await user.click(screen.getByRole("checkbox", { name: "posts" }));
  expect(screen.getByLabelText("Export preview").textContent).toBe(
    exportJson([posts]),
  );
  await user.click(screen.getByRole("checkbox", { name: "Select all" }));
  expect(
    (screen.getByRole("checkbox", { name: "users" }) as HTMLInputElement)
      .checked,
  ).toBe(true);
});

test("Download saves heybe_collections.json from a Blob URL", async () => {
  const create = spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
  const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const click = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    function (this: HTMLAnchorElement) {
      expect(this.download).toBe("heybe_collections.json");
      expect(this.href).toBe("blob:x");
    },
  );
  restores.push(() => {
    create.mockRestore();
    revoke.mockRestore();
    click.mockRestore();
  });
  const { user } = await openExport();
  await user.click(screen.getByRole("button", { name: "Download" }));
  expect(click).toHaveBeenCalledTimes(1);
  const blob = create.mock.calls[0]![0] as Blob;
  expect(await blob.text()).toBe(exportJson(collectionsFixture));
  expect(revoke).toHaveBeenCalledWith("blob:x");
});

test("the import page says imports write no migrations", async () => {
  await openImport();
  const notice = screen.getByText(
    (_, el) =>
      el?.tagName === "P" &&
      el.textContent?.startsWith("Imports do not") === true,
  );
  expect(notice.textContent).toBe(
    "Imports do not write migration files. Run heybe migrate collections afterwards to snapshot the schema.",
  );
  expect(within(notice).getByText("heybe migrate collections").tagName).toBe(
    "CODE",
  );
});

test("invalid JSON shows the parse error and no review", async () => {
  const { user } = await openImport();
  await paste(user, screen.getByLabelText("Collections JSON"), '{"name":"a"}');
  await user.click(screen.getByRole("button", { name: "Review" }));
  expect(
    await screen.findByText("Invalid collections JSON: expected an array."),
  ).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Load from file fills the JSON", async () => {
  const { user } = await openImport();
  const file = new File(['[{"name":"tags"}]'], "c.json", {
    type: "application/json",
  });
  await user.upload(screen.getByLabelText("Collections file"), file);
  expect(await screen.findByDisplayValue('[{"name":"tags"}]')).toBeTruthy();
});

test("Import PUTs collections without deleteMissing after the review", async () => {
  const server = fakeServer().on(
    "PUT",
    "/api/collections/import",
    () => undefined,
  );
  const { user } = await openImport(server);
  const json = JSON.stringify([
    { ...posts, fields: [...posts.fields, { name: "slug", type: "text" }] },
    { name: "tags", type: "base" },
  ]);
  await paste(user, screen.getByLabelText("Collections JSON"), json);
  await user.click(screen.getByRole("button", { name: "Review" }));
  const dialog = within(
    await screen.findByRole("dialog", { name: "Review import" }),
  );
  expect(dialog.getByRole("heading", { name: "Added (1)" })).toBeTruthy();
  expect(dialog.getByText("tags")).toBeTruthy();
  expect(dialog.getByText("posts")).toBeTruthy();
  expect(dialog.getByText("Added fields: slug")).toBeTruthy();
  expect(dialog.queryByRole("heading", { name: /^Deleted/ })).toBeNull();
  const before = server.find("GET", "/api/collections").length;
  await user.click(dialog.getByRole("button", { name: "Import" }));
  await screen.findByText("Collections imported.");
  const [put] = server.find("PUT", "/api/collections/import");
  expect(put!.body).toEqual({
    collections: JSON.parse(json),
    deleteMissing: false,
  });
  expect(server.find("GET", "/api/collections").length).toBeGreaterThan(before);
});

test("Import with deleteMissing lists deletions and asks to confirm", async () => {
  const server = fakeServer().on(
    "PUT",
    "/api/collections/import",
    () => undefined,
  );
  const { user } = await openImport(server);
  const json = JSON.stringify([
    { ...posts, fields: posts.fields.filter((f) => f.name !== "views") },
  ]);
  await paste(user, screen.getByLabelText("Collections JSON"), json);
  await user.click(
    screen.getByLabelText(
      "Delete collections and fields missing from the import",
    ),
  );
  await user.click(screen.getByRole("button", { name: "Review" }));
  const dialog = within(
    await screen.findByRole("dialog", { name: "Review import" }),
  );
  const deleted = dialog.getByRole("list", { name: "Deleted (2)" });
  expect(
    within(deleted)
      .getAllByRole("listitem")
      .map((li) => li.textContent),
  ).toEqual(["stats", "users"]);
  expect(dialog.getByText("Deleted fields: views")).toBeTruthy();
  expect(dialog.queryByText("_superusers")).toBeNull();

  await user.click(dialog.getByRole("button", { name: "Import" }));
  const ask = within(
    await screen.findByRole("dialog", { name: "Delete data" }),
  );
  await user.click(ask.getByRole("button", { name: "Cancel" }));
  expect(server.find("PUT", "/api/collections/import")).toEqual([]);

  await user.click(screen.getByRole("button", { name: "Review" }));
  await user.click(
    within(
      await screen.findByRole("dialog", { name: "Review import" }),
    ).getByRole("button", { name: "Import" }),
  );
  await user.click(
    within(
      await screen.findByRole("dialog", { name: "Delete data" }),
    ).getByRole("button", { name: "Import and delete" }),
  );
  await screen.findByText("Collections imported.");
  expect(server.find("PUT", "/api/collections/import")[0]!.body).toEqual({
    collections: JSON.parse(json),
    deleteMissing: true,
  });
});

test("deleting only a field asks to confirm", async () => {
  const server = fakeServer().on(
    "PUT",
    "/api/collections/import",
    () => undefined,
  );
  const { user } = await openImport(server);
  const list = (
    JSON.parse(exportJson(collectionsFixture)) as typeof collectionsFixture
  ).map((c) =>
    c.name === "posts"
      ? { ...c, fields: c.fields.filter((f) => f.name !== "views") }
      : c,
  );
  await paste(
    user,
    screen.getByLabelText("Collections JSON"),
    JSON.stringify(list),
  );
  await user.click(
    screen.getByLabelText(
      "Delete collections and fields missing from the import",
    ),
  );
  await user.click(screen.getByRole("button", { name: "Review" }));
  const dialog = within(
    await screen.findByRole("dialog", { name: "Review import" }),
  );
  expect(dialog.queryByRole("heading", { name: /^Deleted/ })).toBeNull();
  await user.click(dialog.getByRole("button", { name: "Import" }));
  const ask = within(
    await screen.findByRole("dialog", { name: "Delete data" }),
  );
  expect(
    ask.getByText(
      "This import deletes 1 field with all their data. This cannot be undone.",
    ),
  ).toBeTruthy();
  await user.click(ask.getByRole("button", { name: "Import and delete" }));
  await screen.findByText("Collections imported.");
  expect(server.find("PUT", "/api/collections/import")[0]!.body).toEqual({
    collections: list,
    deleteMissing: true,
  });
});

test("an import error shows the server message", async () => {
  const server = fakeServer().on(
    "PUT",
    "/api/collections/import",
    { code: 400, message: "Failed to import collections.", data: {} },
    400,
  );
  const { user } = await openImport(server);
  await paste(
    user,
    screen.getByLabelText("Collections JSON"),
    '[{"name":"tags"}]',
  );
  await user.click(screen.getByRole("button", { name: "Review" }));
  await user.click(
    within(
      await screen.findByRole("dialog", { name: "Review import" }),
    ).getByRole("button", { name: "Import" }),
  );
  expect(await screen.findByText("Failed to import collections.")).toBeTruthy();
});

test("hideControls hides the import page", async () => {
  const server = fakeServer().on("GET", "/api/settings", {
    ...settingsFixture,
    meta: { ...settingsFixture.meta, hideControls: true },
  });
  renderApp({ path: "/settings/import-collections", server });
  await screen.findByText("Collection controls are hidden.");
  expect(screen.queryByLabelText("Collections JSON")).toBeNull();
});
