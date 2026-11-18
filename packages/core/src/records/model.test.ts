import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type App } from "../app";
import type { Collection } from "../collections/model";
import { RecordModel } from "./model";
import { internalRecords } from "./internal";
import { decode } from "./read";
import { serializeRecord } from "./serialize";
import { cheapPassword, testApp } from "../test-app";

let app: App;

beforeEach(async () => {
  app = testApp();
  await app.collections.save({
    name: "posts",
    fields: [
      { name: "title", type: "text" },
      { name: "views", type: "number" },
      { name: "secret", type: "text", hidden: true },
      {
        name: "tags",
        type: "select",
        values: ["a", "b", "c", "d"],
        maxSelect: 4,
      },
      { name: "pick", type: "select", values: ["a", "b"], maxSelect: 1 },
      { name: "docs", type: "file", maxSelect: 5 },
    ] as any,
  });
  await app.collections.save({
    name: "boards",
    fields: [
      {
        name: "refs",
        type: "relation",
        collectionId: app.collections.find("posts")!.id,
        maxSelect: 5,
      },
    ] as any,
  });
  await app.collections.save({
    name: "members",
    type: "auth",
    fields: [{ name: "name", type: "text" }, cheapPassword] as any,
  });
});

afterEach(() => app.close());

const posts = (): Collection => app.collections.find("posts")!;

describe("public API", () => {
  test("app.records exposes only the five public methods", () => {
    expect(Object.keys(app.records("posts")).sort()).toEqual([
      "create",
      "delete",
      "findMany",
      "findOne",
      "update",
    ]);
  });

  test("the service internals are unreachable at runtime", () => {
    const service = app.records("posts") as unknown as Record<string, unknown>;
    expect(Object.getPrototypeOf(service)).toBe(Object.prototype);
    for (const key of ["findRaw", "deleteWhere", "truncate", "deps", "app"])
      expect(service[key]).toBeUndefined();
    expect(Object.values(service).every((v) => typeof v === "function")).toBe(
      true,
    );
  });
});

describe("set", () => {
  test("select modifiers append, prepend and subtract", () => {
    const r = new RecordModel(posts(), { tags: ["a", "b"] });
    r.set("tags+", "c");
    expect(r.get("tags")).toEqual(["a", "b", "c"]);
    r.set("+tags", ["d", "a"]);
    expect(r.get("tags")).toEqual(["d", "a", "b", "c"]);
    r.set("tags-", ["a", "c"]);
    expect(r.get("tags")).toEqual(["d", "b"]);
    r.set("tags", ["b"]);
    expect(r.get("tags")).toEqual(["b"]);
  });

  test("a single select keeps the last value", () => {
    const r = new RecordModel(posts());
    r.set("pick", "a");
    r.set("pick+", "b");
    expect(r.get("pick")).toBe("b");
  });

  test("relation modifiers", () => {
    const links = app.collections.find("boards")!;
    const r = new RecordModel(links, { refs: ["x1"] });
    r.set("refs+", ["x2"]);
    r.set("+refs", "x0");
    expect(r.get("refs")).toEqual(["x0", "x1", "x2"]);
    r.set("refs-", "x1");
    expect(r.get("refs")).toEqual(["x0", "x2"]);
  });

  test("file modifiers work on names", () => {
    const r = new RecordModel(posts(), { docs: ["a.txt"] });
    r.set("docs+", "b.txt");
    r.set("+docs", "c.txt");
    expect(r.get("docs")).toEqual(["c.txt", "a.txt", "b.txt"]);
    r.set("docs-", "a.txt");
    expect(r.get("docs")).toEqual(["c.txt", "b.txt"]);
  });

  test("number modifiers and unknown keys", () => {
    const r = new RecordModel(posts(), { views: 5 });
    r.set("views+", 3);
    r.set("views-", 1);
    expect(r.get("views")).toBe(7);
    r.set("custom", { a: 1 });
    expect(r.get("custom")).toEqual({ a: 1 });
  });

  test("id is set like any field", () => {
    const r = new RecordModel(posts());
    r.set("id", "custom_id");
    expect(r.id).toBe("custom_id");
    expect(r.toJSON().id).toBe("custom_id");
  });

  test("like PB, an autodate field ignores set and its modifier keys stay custom data", () => {
    const c = {
      ...posts(),
      fields: [...posts().fields, { name: "created", type: "autodate" }],
    } as Collection;
    const r = new RecordModel(
      c,
      { created: "2026-01-01 00:00:00.000Z" },
      false,
    );
    r.set("created", "2030-01-01 00:00:00.000Z");
    r.set("created+", "x");
    expect(r.get("created")).toBe("2026-01-01 00:00:00.000Z");
    expect(r.get("created+")).toBe("x");
  });

  test("a new record starts from the field defaults", () => {
    const r = new RecordModel(posts());
    expect(r.isNew()).toBe(true);
    expect(r.get("tags")).toEqual([]);
    expect(r.get("views")).toBe(0);
  });
});

describe("original", () => {
  test("is unaffected by set", () => {
    const r = new RecordModel(posts(), { id: "abc", title: "a" }, false);
    r.set("title", "b");
    expect(r.get("title")).toBe("b");
    expect(r.original().get("title")).toBe("a");
    expect(r.original().id).toBe("abc");
    expect(r.isNew()).toBe(false);
  });
});

describe("toJSON", () => {
  const record = () =>
    new RecordModel(posts(), { id: "abc", title: "t", secret: "s" }, false);

  test("hidden fields are left out until unhidden", () => {
    const r = record();
    expect(r.toJSON()).not.toHaveProperty("secret");
    r.unhide("secret");
    expect(r.toJSON().secret).toBe("s");
    r.hide("title", "collectionName");
    const json = r.toJSON();
    expect(json).not.toHaveProperty("title");
    expect(json).not.toHaveProperty("collectionName");
  });

  test("custom data is exported only when enabled", () => {
    const r = record();
    r.set("extra", 1);
    r.set("@hbInternalX", 2);
    expect(r.toJSON()).not.toHaveProperty("extra");
    r.withCustomData(true);
    expect(r.toJSON().extra).toBe(1);
    expect(r.toJSON()).not.toHaveProperty("@hbInternalX");
    r.hide("extra");
    expect(r.toJSON()).not.toHaveProperty("extra");
  });

  test("email follows emailVisibility unless hidden", () => {
    const members = app.collections.find("members")!;
    const r = new RecordModel(
      members,
      { id: "m1", email: "a@b.co", emailVisibility: true },
      false,
    );
    expect(r.toJSON().email).toBe("a@b.co");
    r.hide("email");
    expect(r.toJSON()).not.toHaveProperty("email");
    r.set("emailVisibility", false);
    r.unhide("email");
    expect(r.toJSON()).not.toHaveProperty("email");
    r.ignoreEmailVisibility(true);
    expect(r.toJSON().email).toBe("a@b.co");
  });

  test("equals serializeRecord for an auth record, with and without manage access", async () => {
    const users = app.collections.find("members")!;
    const created = await app
      .records("members")
      .create({ email: "a@b.co", password: "12345678", name: "A" } as any);
    const values = decode(
      users,
      internalRecords(app, "members").findRaw(created.id as string),
    );
    const model = () => new RecordModel(users, values, false);

    expect(model().toJSON()).toEqual(
      serializeRecord(users, values, { isSuperuser: false, isOwner: false }),
    );
    expect(model().toJSON()).not.toHaveProperty("email");

    const managed = model();
    managed.ignoreEmailVisibility(true);
    expect(managed.toJSON()).toEqual(
      serializeRecord(users, values, { isSuperuser: false, isOwner: true }),
    );
    expect(managed.toJSON().email).toBe("a@b.co");
    expect(Object.keys(managed.toJSON())).toEqual(
      Object.keys(managed.toJSON()).sort(),
    );
  });

  test("equals serializeRecord for a base record, hidden fields shown as a superuser", () => {
    const values = {
      id: "abc",
      title: "t",
      secret: "s",
      views: 1,
      tags: ["a"],
      pick: "",
      docs: [],
    };
    const r = new RecordModel(posts(), values, false);
    expect(r.toJSON()).toEqual(
      serializeRecord(posts(), values, { isSuperuser: false, isOwner: false }),
    );
    r.unhide("secret");
    expect(r.toJSON()).toEqual(
      serializeRecord(posts(), values, { isSuperuser: true, isOwner: true }),
    );
  });
});
