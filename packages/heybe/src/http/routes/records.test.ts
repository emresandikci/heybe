import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { type App } from "../../app";
import * as model from "../../records/model";
import { toApiError } from "../errors";
import { createEvent } from "../router";
import { createRouter } from "../server";
import { testApp } from "../../test-app";

let app: App;

beforeEach(async () => {
  app = testApp();
  await app.collections.save({
    name: "posts",
    listRule: "",
    viewRule: "",
    fields: [{ name: "title", type: "text" }],
  } as any);
});

afterEach(() => app.close());

async function get(path: string) {
  const url = new URL(path, "http://x");
  const found = createRouter().build().match("GET", url.pathname)!;
  const res = await found.run(createEvent(app, new Request(url), found.params));
  return (await res.json()) as any;
}

test("list and view build no records for enrich without handlers", async () => {
  const { id } = await app.records("posts").create({ title: "a" });
  const { RecordModel } = model;
  type Args = ConstructorParameters<typeof RecordModel>;
  const built = spyOn(model as any, "RecordModel").mockImplementation(
    (...args: Args) => new RecordModel(...args),
  );
  try {
    expect((await get("/api/collections/posts/records")).items).toHaveLength(1);
    expect((await get(`/api/collections/posts/records/${id}`)).id).toBe(id);
    expect(built).not.toHaveBeenCalled();

    app.onRecordEnrich((e) => {
      e.record.withCustomData(true);
      e.record.set("seen", true);
      return e.next();
    });
    expect((await get("/api/collections/posts/records")).items[0].seen).toBe(
      true,
    );
    expect((await get(`/api/collections/posts/records/${id}`)).seen).toBe(true);
    expect(built).toHaveBeenCalledTimes(2);
  } finally {
    built.mockRestore();
  }
});

test("a plain error from an enrich handler answers PB's 500", async () => {
  const { id } = await app.records("posts").create({ title: "a" });
  app.onRecordEnrich(() => {
    throw new Error("boom");
  });
  const log = spyOn(console, "error").mockImplementation(() => {});
  const failure = (path: string) =>
    get(path).then(
      () => null,
      (err) => {
        const { status, message } = toApiError(err);
        return { status, message };
      },
    );
  expect(await failure("/api/collections/posts/records")).toEqual({
    status: 500,
    message: "Failed to enrich records.",
  });
  expect(await failure(`/api/collections/posts/records/${id}`)).toEqual({
    status: 500,
    message: "Failed to enrich record.",
  });
  expect(log).toHaveBeenCalledTimes(2);
  log.mockRestore();
});

test("serveContent sends Last-Modified and 304 from StoredFile.modified", async () => {
  await app.collections.save({
    name: "docs",
    viewRule: "",
    fields: [{ name: "doc", type: "file", maxSelect: 1, maxSize: 1000 }],
  } as any);
  const r = await app.records("docs").create({
    doc: new File(["hello"], "a.txt"),
  });
  const modified = new Date("2026-01-02T03:04:05Z");
  app.files.file = async () => ({
    blob: new Blob(["hello"]),
    size: 5,
    modified,
  });
  const download = async (headers: Record<string, string> = {}) => {
    const url = new URL(`/api/files/docs/${r.id}/${r.doc}`, "http://x");
    const found = createRouter().build().match("GET", url.pathname)!;
    const req = new Request(url, { headers });
    return found.run(createEvent(app, req, found.params));
  };

  const res = await download();
  expect(res.status).toBe(200);
  expect(res.headers.get("last-modified")).toBe(modified.toUTCString());
  expect(await res.text()).toBe("hello");

  const cached = await download({
    "if-modified-since": modified.toUTCString(),
  });
  expect(cached.status).toBe(304);
});

test("a hook that sets e.collection.listRule and saves the collection works and the next request uses the new rule", async () => {
  await app.records("posts").create({ title: "a" });
  await app.records("posts").create({ title: "x" });
  app.onRecordsListRequest(async (e) => {
    if (e.collection.listRule === "") {
      e.collection.listRule = "title = 'x'";
      await app.collections.save(e.collection);
    }
    return e.next();
  });
  // like PB, the rule is applied before the hook runs
  expect((await get("/api/collections/posts/records")).items).toHaveLength(2);
  expect(app.collections.find("posts")!.listRule).toBe("title = 'x'");
  const { items: next } = await get("/api/collections/posts/records");
  expect(next.map((r: any) => r.title)).toEqual(["x"]);

  const fresh = app.collections.find("posts")!;
  await app.collections.save({ ...fresh, listRule: "title = 'a'" });
  const { items } = await get("/api/collections/posts/records");
  expect(items.map((r: any) => r.title)).toEqual(["a"]);
});
