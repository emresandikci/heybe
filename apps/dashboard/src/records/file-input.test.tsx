import { expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { renderApp } from "../test/render";
import { docRecord, docsServer } from "./editor-fixtures";

const group = async (name: string) => {
  await screen.findByRole("dialog");
  return within(await screen.findByRole("group", { name }));
};

const openDoc = (server = docsServer(), record = docRecord()) => {
  server.on("GET", "/api/collections/docs/records/:id", record);
  return renderApp({ path: "/collections/pbc_docs?record=d1", server });
};

const png = (name: string) => new File(["x"], name, { type: "image/png" });

test("create sends the File under the field name as multipart", async () => {
  const server = docsServer().on(
    "POST",
    "/api/collections/docs/records",
    docRecord(),
  );
  const { user } = renderApp({
    path: "/collections/pbc_docs?record=new",
    server,
  });
  const cover = await group("cover");
  await user.upload(cover.getByLabelText("Add files"), png("cat 1.png"));
  expect(cover.getByText("cat 1.png")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Record saved.");
  const [req] = server.find("POST", "/api/collections/docs/records");
  const sent = req!.form!.get("cover") as File;
  expect(sent).toBeInstanceOf(File);
  expect(sent.name).toBe("cat 1.png");
});

test("create with several files sends each under the field name", async () => {
  const server = docsServer().on(
    "POST",
    "/api/collections/docs/records",
    docRecord(),
  );
  const { user } = renderApp({
    path: "/collections/pbc_docs?record=new",
    server,
  });
  const gallery = await group("gallery");
  await user.upload(gallery.getByLabelText("Add files"), [
    png("a.png"),
    png("b.png"),
  ]);
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Record saved.");
  const files = server
    .find("POST", "/api/collections/docs/records")[0]!
    .form!.getAll("gallery");
  expect((files as File[]).map((f) => f.name)).toEqual(["a.png", "b.png"]);
});

test("update sends gallery+ for new files and gallery- for removed names", async () => {
  const server = docsServer().on(
    "PATCH",
    "/api/collections/docs/records/:id",
    docRecord(),
  );
  const { user } = openDoc(server, docRecord({ gallery: ["a.png", "b.png"] }));
  const gallery = await group("gallery");
  await gallery.findByAltText("a.png");
  await user.click(gallery.getByRole("button", { name: "Remove a.png" }));
  expect(gallery.getByRole("button", { name: "Restore a.png" })).toBeTruthy();
  await user.upload(gallery.getByLabelText("Add files"), png("c.png"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Record saved.");
  const [req] = server.find("PATCH", "/api/collections/docs/records/:id");
  expect((req!.form!.getAll("gallery+") as File[]).map((f) => f.name)).toEqual([
    "c.png",
  ]);
  expect(JSON.parse(req!.form!.get("@jsonPayload") as string)).toEqual({
    "gallery-": ["a.png"],
  });
  expect(req!.form!.has("gallery")).toBe(false);
});

test("restoring a removed file sends nothing", async () => {
  const server = docsServer().on(
    "PATCH",
    "/api/collections/docs/records/:id",
    docRecord(),
  );
  const { user } = openDoc(server, docRecord({ gallery: ["a.png"] }));
  const gallery = await group("gallery");
  await user.click(
    await gallery.findByRole("button", { name: "Remove a.png" }),
  );
  await user.click(gallery.getByRole("button", { name: "Restore a.png" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Record saved.");
  expect(
    server.find("PATCH", "/api/collections/docs/records/:id")[0]!.body,
  ).toEqual({});
});

test("a single file replaces the stored one", async () => {
  const server = docsServer().on(
    "PATCH",
    "/api/collections/docs/records/:id",
    docRecord(),
  );
  const { user } = openDoc(server, docRecord({ cover: "old.png" }));
  const cover = await group("cover");
  await cover.findByAltText("old.png");
  await user.upload(cover.getByLabelText("Add files"), png("new.png"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Record saved.");
  const form = server.find("PATCH", "/api/collections/docs/records/:id")[0]!
    .form!;
  expect((form.get("cover") as File).name).toBe("new.png");
  expect(form.has("cover-")).toBe(false);
});

test("removing the single stored file sends cover-", async () => {
  const server = docsServer().on(
    "PATCH",
    "/api/collections/docs/records/:id",
    docRecord(),
  );
  const { user } = openDoc(server, docRecord({ cover: "old.png" }));
  const cover = await group("cover");
  await user.click(
    await cover.findByRole("button", { name: "Remove old.png" }),
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Record saved.");
  expect(
    server.find("PATCH", "/api/collections/docs/records/:id")[0]!.body,
  ).toEqual({
    "cover-": ["old.png"],
  });
});

test("a new file can be dropped before saving", async () => {
  const { user } = renderApp({
    path: "/collections/pbc_docs?record=new",
    server: docsServer(),
  });
  const gallery = await group("gallery");
  await user.upload(gallery.getByLabelText("Add files"), png("a.png"));
  await user.click(gallery.getByRole("button", { name: "Remove new a.png" }));
  expect(gallery.queryByText("a.png")).toBeNull();
});

test("protected thumbs carry the file token", async () => {
  const server = docsServer({ protectedFiles: true }).on(
    "POST",
    "/api/files/token",
    { token: "ft1" },
  );
  openDoc(server, docRecord({ cover: "cat.png" }));
  const img = await screen.findByAltText("cat.png");
  expect(img.getAttribute("src")).toContain("token=ft1");
  expect(img.getAttribute("src")).toContain("thumb=100x100");
});

test("file names with spaces and unicode are encoded in URLs", async () => {
  openDoc(docsServer(), docRecord({ cover: "my cat_ç.png" }));
  const img = await screen.findByAltText("my cat_ç.png");
  expect(img.getAttribute("src")).toContain("/my%20cat_%C3%A7.png");
});

test("clicking an image thumb opens the full image in a dialog", async () => {
  const { user } = openDoc(docsServer(), docRecord({ cover: "cat.png" }));
  await user.click(
    await screen.findByRole("button", { name: "Preview cat.png" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "cat.png" });
  const src = within(dialog).getByAltText("cat.png").getAttribute("src")!;
  expect(src).toContain("/cat.png");
  expect(src).not.toContain("thumb=");
});

test("other files link to the URL in a new tab and names stay text", async () => {
  const hostile = "<img src=x onerror=alert(1)>.pdf";
  openDoc(docsServer(), docRecord({ gallery: [hostile] }));
  const link = await screen.findByRole("link", { name: hostile });
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  expect(link.getAttribute("href")).toContain("%3Cimg%20src%3Dx");
  expect(document.querySelector("img[src=x]")).toBeNull();
});

test("Add files is disabled once kept and new files reach maxSelect", async () => {
  const { user } = openDoc(
    docsServer(),
    docRecord({ gallery: ["a.png", "b.png"] }),
  );
  const gallery = await group("gallery");
  await gallery.findByAltText("a.png");
  const add = gallery.getByLabelText("Add files") as HTMLInputElement;
  expect(add.disabled).toBe(false);
  await user.upload(add, png("c.png"));
  expect(
    (gallery.getByLabelText("Add files") as HTMLInputElement).disabled,
  ).toBe(true);
  await user.click(gallery.getByRole("button", { name: "Remove b.png" }));
  expect(
    (gallery.getByLabelText("Add files") as HTMLInputElement).disabled,
  ).toBe(false);
});
