import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { type App } from "../app";
import { type PasswordValue, fields } from "../fields";
import { NotFoundError, ValidationError } from "../util";
import { serializeRecord } from "./serialize";
import { parseFilter } from "../filter/parse";
import { internalRecords } from "./internal";
import { keyField } from "./service";
import { cheapPassword, testApp } from "../test-app";

const now = () => new Date("2026-01-01T00:00:00.000Z");
const stamp = "2026-01-01 00:00:00.000Z";

const text = (name: string, options = {}) => ({
  name,
  type: "text" as const,
  ...options,
});
const autodates = [
  {
    name: "created",
    type: "autodate" as const,
    onCreate: true,
    onUpdate: false,
  },
  {
    name: "updated",
    type: "autodate" as const,
    onCreate: true,
    onUpdate: true,
  },
] as any;

let app: App;

async function addPosts() {
  await app.collections.save({
    name: "posts",
    fields: [
      text("title", { required: true }),
      { name: "views", type: "number" },
      { name: "tags", type: "select", values: ["a", "b", "c"], maxSelect: 3 },
      ...autodates,
    ] as any,
  });
}

async function failure(promise: Promise<unknown>): Promise<ValidationError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    return e as ValidationError;
  }
  throw new Error("expected a ValidationError");
}

beforeEach(async () => {
  app = testApp({ now });
  await addPosts();
});

afterEach(() => app.close());

describe("create and findOne", () => {
  test("returns the record with collection info and clock timestamps", async () => {
    const created = await app.records("posts").create({ title: "hi" });
    const found = await app.records("posts").findOne(created.id as string);

    expect(found).toEqual({
      collectionId: app.collections.find("posts")!.id,
      collectionName: "posts",
      created: stamp,
      id: created.id,
      tags: [],
      title: "hi",
      updated: stamp,
      views: 0,
    });
    expect(created.id).toMatch(/^[a-z0-9]{15}$/);
    expect(Object.keys(found)).toEqual(Object.keys(found).sort());
  });

  test("keeps a provided id and ignores autodate input", async () => {
    const r = await app
      .records("posts")
      .create({ id: "abcdefghij12345", title: "x", created: "2000-01-01" });
    expect(r.id).toBe("abcdefghij12345");
    expect(r.created).toBe(stamp);
  });

  test("findOne of a missing id throws NotFoundError", async () => {
    await expect(app.records("posts").findOne("nope")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  test("an unknown collection is not found", async () => {
    await expect(app.records("ghost").findMany()).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  test("a duplicate id is a unique validation error", async () => {
    await app.records("posts").create({ id: "abcdefghij12345", title: "a" });
    const e = await failure(
      app.records("posts").create({ id: "abcdefghij12345", title: "b" }),
    );
    expect(e.message).toBe("Failed to create record.");
    expect(e.data).toEqual({
      id: { code: "validation_not_unique", message: "Value must be unique." },
    });
  });

  const addCodes = () =>
    app.collections.save({
      name: "codes",
      fields: [
        {
          name: "id",
          type: "text",
          primaryKey: true,
          required: true,
          pattern: "^[\\w-]+$",
        },
      ] as any,
    });
  // whether each case-insensitive id check ran inside a write
  const nocaseChecks = () => {
    const original = app.db.get.bind(app.db);
    const checks: boolean[] = [];
    spyOn(app.db, "get").mockImplementation((sql, params) => {
      if (sql.includes("COLLATE NOCASE")) checks.push(app.db.inWrite());
      return original(sql, params);
    });
    return checks;
  };

  test("concurrent creates of a custom id differing in case: one wins", async () => {
    await addCodes();
    const results = await Promise.allSettled([
      app.records("codes").create({ id: "ABC" }),
      app.records("codes").create({ id: "abc" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const e = (
      results.find((r) => r.status === "rejected") as PromiseRejectedResult
    ).reason as ValidationError;
    expect(e.message).toBe("Failed to create record.");
    expect(e.data).toEqual({
      id: {
        code: "validation_pk_invalid",
        message: "The record primary key is invalid or already exists.",
      },
    });
  });

  test("a custom id is checked in validation and again inside the write", async () => {
    await addCodes();
    const checks = nocaseChecks();
    await app.records("codes").create({ id: "ABC" });
    expect(checks).toEqual([false, true]);
  });

  test("an id clash is reported with the other field errors", async () => {
    await app.collections.save({
      name: "codes",
      fields: [
        {
          name: "id",
          type: "text",
          primaryKey: true,
          required: true,
          pattern: "^[\\w-]+$",
        },
        { name: "title", type: "text", required: true },
      ] as any,
    });
    await app.records("codes").create({ id: "ABC", title: "a" });
    const e = await failure(app.records("codes").create({ id: "abc" }));
    expect(Object.keys(e.data).sort()).toEqual(["id", "title"]);
    expect((e.data.id as any).code).toBe("validation_pk_invalid");
  });

  test("an id without ASCII letters needs no case-insensitive scan", async () => {
    await addCodes();
    const checks = nocaseChecks();
    await app.records("codes").create({ id: "123" });
    const e = await failure(app.records("codes").create({ id: "123" }));
    expect((e.data.id as any).code).toBe("validation_pk_invalid");
    expect(checks).toEqual([]);
  });

  test("an unvalidated save skips the id check like PB SaveNoValidate", async () => {
    await addCodes();
    await app.records("codes").create({ id: "ABC" });
    const checks = nocaseChecks();
    const service = internalRecords(app, "codes") as any;
    const p = await service.prepare({ id: "abc" });
    await service.commit(p, () =>
      service.save(p, service.draft(p, { id: "abc" }), false),
    );
    expect(checks).toEqual([]);
    expect(service.findRaw("abc").id).toBe("abc");
  });
});

describe("findMany", () => {
  beforeEach(async () => {
    for (const [i, views] of [3, 10, 7, 20, 6, 1].entries())
      await app.records("posts").create({ title: `p${i}`, views });
  });

  test("filters, sorts and paginates", async () => {
    const result = await app.records("posts").findMany({
      where: { views: { gt: 5 } },
      orderBy: { views: "desc" },
      page: 2,
      perPage: 2,
    });
    expect(result.items.map((r) => r.views)).toEqual([7, 6]);
    expect(result).toMatchObject({
      page: 2,
      perPage: 2,
      totalItems: 4,
      totalPages: 2,
    });
  });

  test("count: false skips the totals", async () => {
    const result = await app.records("posts").findMany({ count: false });
    expect(result.totalItems).toBe(-1);
    expect(result.totalPages).toBe(-1);
    expect(result.items).toHaveLength(6);
  });

  test("query combines a rule filter with the client filter", () => {
    const result = internalRecords(app, "posts").query({
      ruleFilter: {
        kind: "cmp",
        op: ">",
        left: { kind: "field", path: "views" },
        right: { kind: "value", value: 5 },
      },
      filter: {
        kind: "cmp",
        op: "<",
        left: { kind: "field", path: "views" },
        right: { kind: "value", value: 10 },
      },
      sort: "-views",
    });
    expect(result.items.map((r) => r.views)).toEqual([7, 6]);
  });
});

describe("update and delete", () => {
  test("update with an invalid value throws PB's validation shape", async () => {
    const r = await app.records("posts").create({ title: "ok" });
    const e = await failure(
      app.records("posts").update(r.id as string, { title: "", tags: ["zzz"] }),
    );
    expect(e.message).toBe("Failed to update record.");
    expect(e.data).toEqual({
      title: { code: "validation_required", message: "Cannot be blank." },
      tags: {
        code: "validation_invalid_value",
        message: "Invalid value zzz.",
        params: { value: "zzz" },
      },
    });
  });

  test("create failure uses the create message", async () => {
    const e = await failure(app.records("posts").create({}));
    expect(e.message).toBe("Failed to create record.");
    expect(e.data).toEqual({
      title: { code: "validation_required", message: "Cannot be blank." },
    });
  });

  test("update changes only the given fields and stamps onUpdate", async () => {
    let t = new Date("2026-01-01T00:00:00.000Z");
    app.close();
    app = testApp({ now: () => t });
    await addPosts();
    const r = await app.records("posts").create({ title: "a", views: 1 });
    t = new Date("2026-02-01T00:00:00.000Z");
    const u = await app.records("posts").update(r.id as string, { views: 2 });
    expect(u).toMatchObject({
      title: "a",
      views: 2,
      created: stamp,
      updated: "2026-02-01 00:00:00.000Z",
    });
  });

  test("field modifiers add, subtract, append, prepend and remove", async () => {
    const r = await app
      .records("posts")
      .create({ title: "a", views: 10, tags: ["a"] });
    const u = await app.records("posts").update(
      r.id as string,
      {
        "views+": 5,
        "tags+": "b",
        "+tags": "c",
      } as any,
    );
    expect(u).toMatchObject({ views: 15, tags: ["c", "a", "b"] });
    const d = await app.records("posts").update(
      r.id as string,
      {
        "views-": 20,
        "tags-": ["a", "c"],
      } as any,
    );
    expect(d).toMatchObject({ views: -5, tags: ["b"] });
  });

  test("keys that only look like modifiers are ignored", async () => {
    const r = await app.records("posts").create({
      title: "a",
      views: 1,
      "+views": 5,
      "title+": "x",
      "+tags+": "a",
      "views:autogenerate": 3,
      "tags:autogenerate": "a",
    } as any);
    expect(r).toMatchObject({ title: "a", views: 1, tags: [] });
  });

  test("modifier keys see fields added to or removed from the same collection object", () => {
    const c = structuredClone(app.collections.find("posts")!);
    expect(keyField(c, "likes+")).toBeNull();
    c.fields.push({ name: "likes", type: "number" } as any);
    expect(keyField(c, "likes+")?.op).toBe("append");
    c.fields.splice(
      c.fields.findIndex((f) => f.name === "views"),
      1,
    );
    expect(keyField(c, "views+")).toBeNull();
  });

  test("modifier keys see fields renamed or replaced in place", () => {
    const c = structuredClone(app.collections.find("posts")!);
    const at = c.fields.findIndex((f) => f.name === "views");
    expect(keyField(c, "views+")?.f.name).toBe("views");
    c.fields[at] = { ...c.fields[at]!, name: "hits" };
    expect(keyField(c, "views+")).toBeNull();
    expect(keyField(c, "hits+")?.f.name).toBe("hits");
    c.fields[at] = { name: "hits", type: "text" } as any;
    expect(keyField(c, "hits+")).toBeNull();
    expect(keyField(c, "hits:autogenerate")?.f).toBe(c.fields[at]);
  });

  test("modifier keys follow a renamed or deleted field", async () => {
    const r = await app.records("posts").create({ title: "a", views: 1 });
    const id = r.id as string;
    await app.records("posts").update(id, { "views+": 1 } as any);
    const posts = app.collections.find("posts")!;
    await app.collections.save({
      ...posts,
      fields: posts.fields
        .filter((f) => f.name !== "tags")
        .map((f) => (f.name === "views" ? { ...f, name: "hits" } : f)),
    } as any);
    const u = await app
      .records("posts")
      .update(id, { "views+": 10, "hits+": 2, "tags+": "a" } as any);
    expect(u).toMatchObject({ hits: 4 });
    expect(u).not.toHaveProperty("views");
    expect(u).not.toHaveProperty("tags");
  });

  test("text :autogenerate appends a random value", async () => {
    await app.collections.save({
      name: "slugs",
      fields: [text("slug", { autogeneratePattern: "[a-z]{4}" })] as any,
    });
    const r = await app
      .records("slugs")
      .create({ "slug:autogenerate": "x-" } as any);
    expect(r.slug).toMatch(/^x-[a-z]{4}$/);
    const e = await app.records("slugs").create({});
    expect(e.slug).toMatch(/^[a-z]{4}$/);
  });

  test("delete removes the record", async () => {
    const r = await app.records("posts").create({ title: "a" });
    await app.records("posts").delete(r.id as string);
    await expect(
      app.records("posts").findOne(r.id as string),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      app.records("posts").delete(r.id as string),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("delete unlinks and cascades relations", async () => {
    const posts = app.collections.find("posts")!;
    await app.collections.save({
      name: "notes",
      fields: [
        {
          name: "post",
          type: "relation",
          collectionId: posts.id,
          maxSelect: 1,
          cascadeDelete: true,
        },
      ] as any,
    });
    await app.collections.save({
      name: "links",
      fields: [
        {
          name: "posts",
          type: "relation",
          collectionId: posts.id,
          maxSelect: 5,
        },
      ] as any,
    });
    const a = await app.records("posts").create({ title: "a" });
    const b = await app.records("posts").create({ title: "b" });
    const note = await app.records("notes").create({ post: a.id });
    const link = await app.records("links").create({ posts: [a.id, b.id] });

    await app.records("posts").delete(a.id as string);

    await expect(
      app.records("notes").findOne(note.id as string),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      (await app.records("links").findOne(link.id as string)).posts,
    ).toEqual([b.id]);
  });

  test("truncate succeeds when a cascade already removed later records", async () => {
    await app.collections.save({
      name: "nodes",
      fields: [text("name")] as any,
    });
    const nodes = app.collections.find("nodes")!;
    await app.collections.save({
      ...nodes,
      fields: [
        ...nodes.fields,
        {
          name: "parent",
          type: "relation",
          collectionId: nodes.id,
          maxSelect: 1,
          cascadeDelete: true,
        },
      ] as any,
    });
    const root = await app.records("nodes").create({ name: "root" });
    await app.records("nodes").create({ name: "a", parent: root.id });
    await app.records("nodes").create({ name: "b", parent: root.id });

    await internalRecords(app, "nodes").truncate();

    expect((await app.records("nodes").findMany()).totalItems).toBe(0);
  });
});

describe("auth records", () => {
  beforeEach(async () => {
    await app.collections.delete("users");
    await app.collections.save({
      name: "users",
      type: "auth",
      fields: [text("name"), cheapPassword] as any,
    });
  });

  test("hashes the password and never returns secrets", async () => {
    const r = await app
      .records("users")
      .create({ email: "a@b.co", password: "12345678", name: "A" } as any);
    expect(r).not.toHaveProperty("password");
    expect(r).not.toHaveProperty("tokenKey");
    expect(r.email).toBe("a@b.co");

    const raw = internalRecords(app, "users").findRaw(r.id as string) as any;
    expect(raw.password.hash).toMatch(/^\$2/);
    expect(raw.password.plain).toBe("");
    expect(raw.tokenKey).toHaveLength(50);
  });

  test("the plain password does not outlive validation", async () => {
    const toDb = spyOn(fields.password, "toDb");
    try {
      const users = internalRecords(app, "users") as any;
      const r = await users.create({ email: "a@b.co", password: "12345678" });
      await users.update(r.id, { password: "87654321" });
      const written = toDb.mock.calls.map(([v]) => v as PasswordValue);
      expect(written).toHaveLength(2);
      for (const v of written) {
        expect(v.plain).toBe("");
        expect(v.hash).toMatch(/^\$2/);
      }
    } finally {
      toDb.mockRestore();
    }
  });

  test("a password or email change refreshes the tokenKey", async () => {
    const users = internalRecords(app, "users") as any;
    const r = await users.create({ email: "a@b.co", password: "12345678" });
    const before = users.findRaw(r.id).tokenKey;
    await users.update(r.id, { name: "n" });
    expect(users.findRaw(r.id).tokenKey).toBe(before);
    await users.update(r.id, { password: "87654321" });
    const after = users.findRaw(r.id).tokenKey;
    expect(after).not.toBe(before);
    await users.update(r.id, { email: "c@d.co" });
    expect(users.findRaw(r.id).tokenKey).not.toBe(after);
  });

  test("keeps the existing password when none is given", async () => {
    const users = internalRecords(app, "users") as any;
    const r = await users.create({ email: "a@b.co", password: "12345678" });
    const hash = users.findRaw(r.id).password.hash;
    await users.update(r.id, { name: "x" });
    expect(users.findRaw(r.id).password.hash).toBe(hash);
  });

  test("serializeRecord applies emailVisibility, hidden fields and fields param", async () => {
    const users = app.collections.find("users")!;
    const row = {
      id: "i",
      email: "a@b.co",
      emailVisibility: false,
      verified: false,
      name: "A",
      password: null,
      tokenKey: "k",
      created: "",
      updated: "",
    };
    const pub = serializeRecord(users, row, {
      isSuperuser: false,
      isOwner: false,
    });
    expect(pub).not.toHaveProperty("email");
    expect(
      serializeRecord(users, row, { isSuperuser: false, isOwner: true }).email,
    ).toBe("a@b.co");
    expect(
      serializeRecord(
        users,
        { ...row, emailVisibility: true },
        { isSuperuser: false, isOwner: false },
      ).email,
    ).toBe("a@b.co");
    expect(
      serializeRecord(users, row, { isSuperuser: true, isOwner: false }),
    ).not.toHaveProperty("tokenKey");
    expect(
      serializeRecord(users, row, {
        isSuperuser: true,
        isOwner: false,
        fields: "id,name",
      }),
    ).toEqual({ id: "i", name: "A" });
    expect(
      serializeRecord(users, row, {
        isSuperuser: true,
        isOwner: false,
        fields: "*,-x",
      }),
    ).toHaveProperty("collectionName", "users");
  });

  test("hidden fields are shown to superusers only", async () => {
    await app.collections.save({
      name: "secrets",
      fields: [text("note", { hidden: true }), text("open")] as any,
    });
    const c = app.collections.find("secrets")!;
    const row = { id: "i", note: "n", open: "o" };
    expect(
      serializeRecord(c, row, { isSuperuser: false, isOwner: false }),
    ).not.toHaveProperty("note");
    expect(
      serializeRecord(c, row, { isSuperuser: true, isOwner: false }),
    ).toHaveProperty("note", "n");
  });
});

describe("concurrency", () => {
  test("50 parallel creates on a file-backed db all succeed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-"));
    const file = testApp({ dir, now });
    try {
      await file.collections.save({
        name: "items",
        fields: [text("n"), ...autodates] as any,
      });
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          file.records("items").create({ n: String(i) }),
        ),
      );
      const result = await file.records("items").findMany({ perPage: 100 });
      expect(result.totalItems).toBe(50);
      expect(new Set(result.items.map((r) => r.id)).size).toBe(50);
    } finally {
      file.close();
      rmSync(dir, { recursive: true });
    }
  });
});

describe("file uploads", () => {
  let dir: string;
  let disk: App;
  const txt = (name = "doc.txt", body = "hello") => new File([body], name);
  const storage = () => join(dir, "storage");
  const stored = (): string[] =>
    existsSync(storage())
      ? readdirSync(storage(), { recursive: true, withFileTypes: true })
          .filter((d) => d.isFile())
          .map((d) => relative(storage(), join(d.parentPath, d.name)))
          .sort()
      : [];
  const keysOf = (c: string, r: Record<string, unknown>, names: string[]) =>
    names.map((n) => join(disk.collections.find(c)!.id, r.id as string, n));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "hb-"));
    disk = testApp({ dir, now });
    await disk.collections.save({
      name: "docs",
      fields: [
        text("title", { required: true }),
        { name: "file", type: "file", maxSelect: 1 },
        { name: "files", type: "file", maxSelect: 3, maxSize: 10 },
      ] as any,
      indexes: ["CREATE UNIQUE INDEX idx_docs_title ON docs (title)"],
    } as any);
  });

  afterEach(() => {
    disk.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("create stores new files under the record dir", async () => {
    const r = await disk
      .records("docs")
      .create({ title: "a", file: txt(), files: [txt("b.txt")] } as any);
    expect(r.file).toMatch(/^doc_[a-z0-9]{10}\.txt$/);
    expect(stored()).toEqual(
      keysOf("docs", r, [r.file as string, ...(r.files as string[])]).sort(),
    );
  });

  test("an update in a rolled back savepoint keeps the old file", async () => {
    const r = await disk
      .records("docs")
      .create({ title: "a", file: txt() } as any);
    await disk.db.write(async () => {
      await disk.db
        .write(async () => {
          await disk
            .records("docs")
            .update(r.id as string, { file: txt("new.txt") } as any);
          throw new Error("undo");
        })
        .catch(() => {});
    });
    expect(internalRecords(disk, "docs").findRaw(r.id as string).file).toBe(
      r.file,
    );
    expect(stored()).toEqual(keysOf("docs", r, [r.file as string]));
  });

  test("a create failing validation leaves no files", async () => {
    await failure(disk.records("docs").create({ file: txt() } as any));
    await failure(
      disk
        .records("docs")
        .create({ title: "a", files: [txt("b", "x".repeat(11))] } as any),
    );
    expect(stored()).toEqual([]);
    expect(existsSync(storage()) ? readdirSync(storage()) : []).toEqual([]);
  });

  test("a create failing in the write leaves no files", async () => {
    await disk.records("docs").create({ title: "a" });
    const e = await failure(
      disk.records("docs").create({ title: "a", file: txt() } as any),
    );
    expect(e.data).toHaveProperty("title.code", "validation_not_unique");
    expect(stored()).toEqual([]);
  });

  test("an unusable record id writes nothing outside the record dir", async () => {
    await failure(
      disk
        .records("docs")
        .create({ id: "a/b", title: "a", file: txt() } as any),
    );
    expect(stored()).toEqual([]);
  });

  test("a failed update keeps the old files and drops the new ones", async () => {
    const docs = disk.records("docs");
    const r = await docs.create({ title: "a", file: txt() } as any);
    await docs.create({ title: "b" });
    await failure(
      docs.update(r.id as string, { title: "b", file: txt() } as any),
    );
    expect(stored()).toEqual(keysOf("docs", r, [r.file as string]));
  });

  test("update deletes replaced files only after the commit", async () => {
    const docs = disk.records("docs");
    const r = await docs.create({ title: "a", file: txt() } as any);
    const u = await docs.update(
      r.id as string,
      { file: txt("new.txt") } as any,
    );
    expect(u.file).toMatch(/^new_/);
    expect(stored()).toEqual(keysOf("docs", u, [u.file as string]));
  });

  test("uploads the final value does not keep are removed", async () => {
    const r = await disk
      .records("docs")
      .create({ title: "a", file: [txt("one.txt"), txt("two.txt")] } as any);
    expect(r.file).toMatch(/^two_/);
    expect(stored()).toEqual(keysOf("docs", r, [r.file as string]));
  });

  test("id:autogenerate stores files under the final record id", async () => {
    const r = await disk
      .records("docs")
      .create({ "id:autogenerate": "", title: "a", file: txt() } as any);
    expect(stored()).toEqual(keysOf("docs", r, [r.file as string]));
  });

  test("Files nested in the input are uploaded, never stored by client name", async () => {
    const r = await disk
      .records("docs")
      .create({ title: "a", files: [[txt("nested.txt", "x")]] } as any);
    expect((r.files as string[])[0]).toMatch(/^nested_[a-z0-9]{10}\.txt$/);
    expect(stored()).toEqual(keysOf("docs", r, r.files as string[]));
  });

  test("collection delete removes the collection storage dir", async () => {
    await disk.records("docs").create({ title: "a", file: txt() } as any);
    const id = disk.collections.find("docs")!.id;
    expect(existsSync(join(storage(), id))).toBe(true);
    await disk.collections.delete("docs");
    expect(existsSync(join(storage(), id))).toBe(false);
  });

  test("delete and truncate remove the record dirs", async () => {
    const docs = internalRecords(disk, "docs");
    const a = await docs.create({ title: "a", file: txt() } as any);
    await docs.create({ title: "b", file: txt() } as any);
    await docs.delete(a.id as string);
    expect(stored()).toHaveLength(1);
    await docs.truncate();
    expect(stored()).toEqual([]);
  });
});

describe("list totals", () => {
  beforeEach(async () => {
    const authors = await app.collections.save({
      name: "authors",
      fields: [text("name")],
    } as any);
    const posts = app.collections.find("posts")!;
    await app.collections.save({
      ...posts,
      fields: [
        ...posts.fields,
        {
          name: "author",
          type: "relation",
          collectionId: authors.id,
          maxSelect: 1,
        },
        {
          name: "editors",
          type: "relation",
          collectionId: authors.id,
          maxSelect: 5,
        },
      ],
    } as any);
    await app.collections.save({
      name: "comments",
      fields: [
        text("body"),
        {
          name: "post",
          type: "relation",
          collectionId: posts.id,
          maxSelect: 1,
        },
      ],
    } as any);
    const ann = await app.records("authors").create({ name: "ann" });
    const ann2 = await app.records("authors").create({ name: "ann" });
    const bob = await app.records("authors").create({ name: "bob" });
    const p1 = await app.records("posts").create({
      title: "p1",
      tags: ["a", "b"],
      author: ann.id,
      editors: [ann.id, ann2.id],
    });
    await app.records("posts").create({
      title: "p2",
      author: ann2.id,
      editors: [bob.id],
    });
    await app.records("posts").create({ title: "p3", author: bob.id });
    for (const body of ["c", "c"])
      await app.records("comments").create({ body, post: p1.id });
  });

  const count = (
    filter: string,
    auth: Record<string, unknown> | null = null,
  ) => {
    const get = spyOn(app.db, "get");
    try {
      const { totalItems } = internalRecords(app, "posts").query({
        filter: parseFilter(filter),
        request: auth && {
          auth,
          authCollection: "users",
          body: {},
          query: {},
          headers: {},
          method: "GET",
          context: "default",
        },
      });
      const sql = get.mock.calls
        .map(([s]) => s)
        .find((s) => s.includes("COUNT("))!;
      return { totalItems, distinct: sql.includes("COUNT(DISTINCT") };
    } finally {
      get.mockRestore();
    }
  };

  test.each([
    ["", 3],
    ['title != ""', 3],
    ['author.name = "ann"', 2],
    ['author.name = "ann" && author.id != ""', 2],
  ])("to-one joins count rows: %p", (filter, total) => {
    expect(count(filter)).toEqual({ totalItems: total, distinct: false });
  });

  test.each([
    ['editors.name ?= "ann"', 1],
    ['editors.name = "ann"', 1],
    ['comments_via_post.body ?= "c"', 1],
    ['tags:each ?!= "z"', 3],
    ['@collection.authors.name ?= "ann" && author.name = "ann"', 2],
  ])("to-many joins count distinct rows: %p", (filter, total) => {
    expect(count(filter)).toEqual({ totalItems: total, distinct: true });
  });

  // three rows of each back collection point to the first post; only "covers" and "pins" allow one
  test.each([
    ["covers", "CREATE UNIQUE INDEX idx_covers_post ON covers (post)", false],
    [
      "pins",
      "CREATE UNIQUE INDEX idx_pins_post ON pins (post) WHERE post != ''",
      false,
    ],
    [
      "drafts",
      "CREATE UNIQUE INDEX idx_drafts_post ON drafts (post) WHERE active = TRUE",
      true,
    ],
  ])(
    "a back relation through %p counts distinct only when it can repeat",
    async (name, index, distinct) => {
      const posts = app.collections.find("posts")!;
      await app.collections.save({
        name,
        fields: [
          text("body"),
          { name: "active", type: "bool" },
          {
            name: "post",
            type: "relation",
            collectionId: posts.id,
            maxSelect: 1,
          },
        ],
        indexes: [index],
      } as any);
      const [p1] = internalRecords(app, "posts").query({
        filter: parseFilter('title = "p1"'),
      }).items;
      const rows = name === "drafts" ? 3 : 1;
      for (let i = 0; i < rows; i++)
        await app.records(name).create({ body: "x", post: p1!.id });
      expect(count(`${name}_via_post.body = "x"`)).toEqual({
        totalItems: 1,
        distinct,
      });
    },
  );

  test("an @request.auth field joins one row", async () => {
    const user = await app.records("users").create({
      email: "u@example.com",
      password: "1234567890",
      name: "u",
    });
    expect(count('@request.auth.name = "u"', { id: user.id })).toEqual({
      totalItems: 3,
      distinct: false,
    });
  });
});
