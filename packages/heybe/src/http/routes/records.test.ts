import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { type App, createApp } from "../../app";
import * as model from "../../records/model";
import { toApiError } from "../errors";
import { createEvent } from "../router";
import { createRouter } from "../server";

let app: App;

beforeEach(async () => {
  app = createApp({ dir: "" });
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
