import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App } from "../app";
import { RecordHooks } from "../extend/record-hooks";
import type { PasswordValue } from "../fields";
import { internalRecords } from "../records/internal";
import { INSTALLER_EMAIL } from "../util";
import type { HookEvent, HookHandler } from "./hook";
import type { RecordErrorEvent, RecordEvent } from "./events";
import { cheapPassword, testApp } from "../test-app";

let app: App;
const text = (name: string, opts = {}) => ({ name, type: "text", ...opts });
const count = (table: string, where = "1 = 1", params: unknown[] = []) =>
  app.db.get<{ n: number }>(
    `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
    params,
  )!.n;
const bind = (name: string, fn: HookHandler<any>, opts = {}) =>
  (app.hooks as any)[name].bind(fn, opts);

const REFS = ["_otps", "_mfas", "_authOrigins", "_externalAuths"];

async function addRefs(collection: string, recordId: string) {
  const ref = { collectionRef: app.collections.find(collection)!.id };
  const data = { ...ref, recordRef: recordId };
  await app.records("_otps").create({ ...data, password: "x" });
  await app.records("_mfas").create({ ...data, method: "otp" });
  await app.records("_authOrigins").create({ ...data, fingerprint: "f" });
  await app
    .records("_externalAuths")
    .create({ ...data, provider: "google", providerId: recordId });
}

function logDeletes(): string[] {
  const deleted: string[] = [];
  app.onRecordAfterDeleteSuccess((e) => {
    deleted.push(e.record.collection.name);
    return e.next();
  });
  return deleted;
}

beforeEach(async () => {
  app = testApp();
  await app.collections.save({ name: "posts", fields: [text("title")] as any });
  await app.collections.save({ name: "audit", fields: [text("note")] as any });
});

afterEach(() => app.close());

describe("order", () => {
  const STAGES = {
    create: ["Create", "Validate", "CreateExecute", "AfterCreateSuccess"],
    update: ["Update", "Validate", "UpdateExecute", "AfterUpdateSuccess"],
    delete: ["Delete", "DeleteExecute", "AfterDeleteSuccess"],
  };

  function record(log: string[]) {
    const stages = new Set(Object.values(STAGES).flat());
    for (const stage of stages)
      for (const kind of ["Model", "Record"])
        for (const p of [-100, 0, 100])
          bind(
            `on${kind}${stage}`,
            (e: HookEvent) => {
              log.push(`${kind}${stage} ${p}`);
              return e.next();
            },
            { priority: p },
          );
  }

  const expected = (stages: string[]) =>
    stages.flatMap((s) =>
      [
        ["Model", -100],
        ["Record", -100],
        ["Record", 0],
        ["Record", 100],
        ["Model", 0],
        ["Model", 100],
      ].map(([kind, p]) => `${kind}${s} ${p}`),
    );

  test("create, update and delete follow PB core/db.go with the record bridge at -99", async () => {
    const log: string[] = [];
    record(log);
    const posts = app.records("posts");
    const r = await posts.create({ title: "a" });
    expect(log).toEqual(expected(STAGES.create));
    log.length = 0;
    await posts.update(r.id as string, { title: "b" });
    expect(log).toEqual(expected(STAGES.update));
    log.length = 0;
    await posts.delete(r.id as string);
    expect(log).toEqual(expected(STAGES.delete));
  });

  test("a record execute handler runs before a model execute handler of the same priority", async () => {
    const log: string[] = [];
    app.onModelCreateExecute((e) => {
      log.push("model");
      return e.next();
    });
    app.onRecordCreateExecute((e) => {
      log.push("record");
      return e.next();
    });
    await app.records("posts").create({ title: "a" });
    expect(log).toEqual(["record", "model"]);
  });
});

describe("records", () => {
  test("a handler that skips next() writes nothing; like PB the after-success hooks still fire", async () => {
    const after: string[] = [];
    app.onRecordCreate("posts", () => {});
    app.onRecordAfterCreateSuccess((e) => {
      after.push(e.record.collection.name);
      return e.next();
    });
    app.onRecordAfterCreateError(() => {
      throw new Error("unexpected");
    });
    await app.records("posts").create({ title: "a" });
    expect(count("posts")).toBe(0);
    expect(after).toEqual(["posts"]);
  });

  test("a throw in onRecordCreateExecute leaves no row and no file, and fires the after-error hooks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-"));
    const disk = testApp({ dir });
    try {
      await disk.collections.save({
        name: "docs",
        fields: [{ name: "file", type: "file", maxSelect: 1 }] as any,
      });
      const boom = new Error("boom");
      const errors: unknown[] = [];
      disk.onRecordCreateExecute("docs", () => {
        throw boom;
      });
      disk.onRecordAfterCreateError("docs", (e: RecordErrorEvent) => {
        errors.push(e.error);
        return e.next();
      });
      await expect(
        disk.records("docs").create({ file: new File(["x"], "a.txt") }),
      ).rejects.toBe(boom);
      expect(errors).toEqual([boom]);
      expect(disk.db.get("SELECT 1 FROM docs")).toBeNull();
      const storage = join(dir, "storage");
      const files = existsSync(storage)
        ? readdirSync(storage, { recursive: true, withFileTypes: true })
        : [];
      expect(files.filter((d) => d.isFile())).toEqual([]);
    } finally {
      disk.close();
      rmSync(dir, { recursive: true });
    }
  });

  test("onRecordAfterCreateSuccess sees the committed row on the reader", async () => {
    let seen: unknown = null;
    app.onRecordAfterCreateSuccess("posts", (e) => {
      seen = app.db.get("SELECT title FROM posts WHERE id = ?", [e.record.id]);
      return e.next();
    });
    await app.records("posts").create({ title: "a" });
    expect(seen).toEqual({ title: "a" });
  });

  test("a plain create runs onRecordCreate outside any transaction", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inHook = new Promise<void>((r) => (entered = r));
    app.onRecordCreate("posts", async (e) => {
      entered();
      await gate;
      await e.next();
    });
    const creating = app.records("posts").create({ title: "a" });
    await inHook;
    let other = false;
    const write = app.db.write(() => {
      other = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(other).toBe(true);
    await write;
    release();
    await creating;
    expect(count("posts")).toBe(1);
  });

  test("a delete execute handler at 100 runs inside the cascade transaction", async () => {
    const posts = app.collections.find("posts")!;
    await app.collections.save({
      name: "comments",
      fields: [
        {
          name: "post",
          type: "relation",
          collectionId: posts.id,
          required: true,
          maxSelect: 1,
        },
      ] as any,
    });
    const post = await app.records("posts").create({ title: "a" });
    await app.records("comments").create({ post: post.id });
    app.onRecordDeleteExecute(
      "posts",
      async (e) => {
        await e.app.records("audit").create({ note: "deleted" });
        await e.next();
      },
      { priority: 100 },
    );
    await expect(
      app.records("posts").delete(post.id as string),
    ).rejects.toThrow("required reference");
    expect(count("audit")).toBe(0);
    expect(count("posts")).toBe(1);
  });

  test("inside a transaction the after-success hooks fire only after COMMIT", async () => {
    const fired: boolean[] = [];
    app.onRecordAfterCreateSuccess("posts", (e) => {
      fired.push(count("posts") === 1);
      return e.next();
    });
    await app.db.write(async () => {
      await app.records("posts").create({ title: "a" });
      expect(fired).toEqual([]);
    });
    expect(fired).toEqual([true]);
  });

  test("a rolled back transaction fires the after-error hooks instead", async () => {
    const errors: unknown[] = [];
    app.onRecordAfterCreateError("posts", (e) => {
      errors.push(e.error);
      return e.next();
    });
    const boom = new Error("boom");
    await app.db
      .write(async () => {
        await app.records("posts").create({ title: "a" });
        throw boom;
      })
      .catch(() => {});
    expect(errors).toEqual([boom]);
  });

  test("a password set in onRecordCreate is stored as a working hash", async () => {
    app.onRecordCreate("users", (e) => {
      e.record.set("password", "12345678");
      return e.next();
    });
    const user = await app.records("users").create({ email: "a@b.co" });
    const raw = internalRecords(app, "users").findRaw(user.id as string);
    const hash = (raw.password as PasswordValue).hash;
    expect(await Bun.password.verify("12345678", hash)).toBe(true);
  });

  test("a create inside onRecordAfterCreateSuccess works", async () => {
    app.onRecordAfterCreateSuccess("posts", async (e) => {
      await e.app.records("audit").create({ note: e.record.id });
      await e.next();
    });
    const post = await app.records("posts").create({ title: "a" });
    expect(count("audit", "note = ?", [post.id])).toBe(1);
  });

  test("a registered RecordHooks class fires only for its collection", async () => {
    const seen: string[] = [];
    class PostHooks extends RecordHooks {
      collection = "posts";
      onCreate(e: RecordEvent) {
        seen.push(e.record.collection.name);
        return e.next();
      }
    }
    app.register(PostHooks);
    await app.records("posts").create({ title: "a" });
    await app.records("audit").create({ note: "a" });
    expect(seen).toEqual(["posts"]);
  });
});

describe("collections", () => {
  test("save and delete fire the collection hooks", async () => {
    const log: string[] = [];
    for (const name of [
      "onCollectionCreate",
      "onCollectionValidate",
      "onCollectionCreateExecute",
      "onCollectionAfterCreateSuccess",
      "onCollectionUpdate",
      "onCollectionAfterUpdateSuccess",
      "onCollectionDelete",
      "onCollectionDeleteExecute",
      "onCollectionAfterDeleteSuccess",
    ])
      bind(name, (e: any) => {
        log.push(`${name} ${e.collection.name}`);
        return e.next();
      });
    const c = await app.collections.save({ name: "tags" });
    await app.collections.save({ ...c, listRule: "" });
    await app.collections.delete("tags");
    expect(log).toEqual([
      "onCollectionCreate tags",
      "onCollectionValidate tags",
      "onCollectionCreateExecute tags",
      "onCollectionAfterCreateSuccess tags",
      "onCollectionUpdate tags",
      "onCollectionValidate tags",
      "onCollectionAfterUpdateSuccess tags",
      "onCollectionDelete tags",
      "onCollectionDeleteExecute tags",
      "onCollectionAfterDeleteSuccess tags",
    ]);
    expect(app.collections.find("tags")).toBeNull();
  });
});

describe("auth references", () => {
  test("deleting an auth record deletes its rows through the hooked delete", async () => {
    const users = app.records("users");
    const a = await users.create({ email: "a@b.co", password: "12345678" });
    const b = await users.create({ email: "b@b.co", password: "12345678" });
    await addRefs("users", a.id as string);
    await addRefs("users", b.id as string);
    const deleted = logDeletes();
    await users.delete(a.id as string);
    expect(deleted.sort()).toEqual([...REFS, "users"].sort());
    for (const table of REFS) {
      expect(count(table, "recordRef = ?", [a.id])).toBe(0);
      expect(count(table, "recordRef = ?", [b.id])).toBe(1);
    }
  });

  test("deleting an auth collection deletes its rows", async () => {
    await app.collections.save({
      name: "members",
      type: "auth",
      fields: [cheapPassword] as any,
    });
    const m = await app
      .records("members")
      .create({ email: "a@b.co", password: "12345678" });
    const u = await app
      .records("users")
      .create({ email: "a@b.co", password: "12345678" });
    await addRefs("members", m.id as string);
    await addRefs("users", u.id as string);
    await app.collections.delete("members");
    for (const table of REFS) {
      expect(count(table, "recordRef = ?", [m.id])).toBe(0);
      expect(count(table, "recordRef = ?", [u.id])).toBe(1);
    }
  });
});

describe("short-circuits and errors", () => {
  test("update and delete handlers that skip next() write nothing", async () => {
    const posts = app.records("posts");
    const post = await posts.create({ title: "a" });
    app.onRecordUpdate("posts", () => {});
    app.onRecordDelete("posts", () => {});
    await posts.update(post.id as string, { title: "b" });
    await posts.delete(post.id as string);
    expect(app.db.query("SELECT title FROM posts")).toEqual([{ title: "a" }]);
  });

  test("a throw in onRecordUpdate or onRecordDelete fires the after-error hooks", async () => {
    const posts = app.records("posts");
    const post = await posts.create({ title: "a" });
    const boom = new Error("boom");
    const errors: unknown[] = [];
    app.onRecordUpdate("posts", () => {
      throw boom;
    });
    app.onRecordDelete("posts", () => {
      throw boom;
    });
    for (const name of ["onRecordAfterUpdateError", "onRecordAfterDeleteError"])
      bind(name, (e: RecordErrorEvent) => {
        errors.push(e.error);
        return e.next();
      });
    await expect(posts.update(post.id as string, { title: "b" })).rejects.toBe(
      boom,
    );
    await expect(posts.delete(post.id as string)).rejects.toBe(boom);
    expect(errors).toEqual([boom, boom]);
    expect(app.db.query("SELECT title FROM posts")).toEqual([{ title: "a" }]);
  });

  test("a failed or rolled back create leaves the record new again", async () => {
    const isNew: boolean[] = [];
    app.onRecordCreateExecute("posts", async (e) => {
      await e.next();
      throw new Error("late");
    });
    app.onRecordAfterCreateError((e) => {
      isNew.push(e.record.isNew());
      return e.next();
    });
    await expect(app.records("posts").create({ title: "a" })).rejects.toThrow(
      "late",
    );
    await app.db
      .write(async () => {
        await app.records("audit").create({ note: "a" });
        throw new Error("rollback");
      })
      .catch(() => {});
    expect(isNew).toEqual([true, true]);
  });

  test("records deleted by a cascade that rolls back get the after-error hooks", async () => {
    const posts = app.collections.find("posts")!;
    const relation = (name: string, opts: object) => ({
      name,
      type: "relation",
      collectionId: posts.id,
      maxSelect: 1,
      ...opts,
    });
    await app.collections.save({
      name: "comments",
      fields: [relation("post", { cascadeDelete: true })] as any,
    });
    await app.collections.save({
      name: "notes",
      fields: [relation("post", { required: true })] as any,
    });
    const post = await app.records("posts").create({ title: "a" });
    await app.records("comments").create({ post: post.id });
    await app.records("notes").create({ post: post.id });
    const failed: string[] = [];
    app.onRecordAfterDeleteError((e) => {
      failed.push(e.record.collection.name);
      return e.next();
    });
    const deleted = logDeletes();
    await expect(
      app.records("posts").delete(post.id as string),
    ).rejects.toThrow("required reference");
    expect(failed.sort()).toEqual(["comments", "posts"]);
    expect(deleted).toEqual([]);
    expect(count("comments")).toBe(1);
  });

  test("a throwing after-success hook keeps the committed row and its files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-"));
    const disk = testApp({ dir });
    const stored = () =>
      readdirSync(join(dir, "storage"), {
        recursive: true,
        withFileTypes: true,
      })
        .filter((d) => d.isFile())
        .map((d) => d.name);
    try {
      await disk.collections.save({
        name: "docs",
        fields: [{ name: "file", type: "file", maxSelect: 1 }] as any,
      });
      for (const name of [
        "onRecordAfterCreateSuccess",
        "onRecordAfterUpdateSuccess",
      ] as const)
        disk[name]("docs", () => {
          throw new Error("after");
        });
      const docs = disk.records("docs");
      await expect(
        docs.create({ id: "doc1234567890ab", file: new File(["x"], "a.txt") }),
      ).rejects.toThrow("after");
      const first = disk.db.get<{ file: string }>("SELECT file FROM docs")!;
      expect(stored()).toEqual([first.file]);

      await expect(
        docs.update("doc1234567890ab", { file: new File(["y"], "b.txt") }),
      ).rejects.toThrow("after");
      const second = disk.db.get<{ file: string }>("SELECT file FROM docs")!;
      expect(second.file).not.toBe(first.file);
      expect(stored()).toEqual([second.file]);
    } finally {
      disk.close();
      rmSync(dir, { recursive: true });
    }
  });

  test("RecordHooks binds at its priority, with a collection id as the tag", async () => {
    const log: string[] = [];
    const id = app.collections.find("posts")!.id;
    class PostHooks extends RecordHooks {
      collection = id;
      priority = 10;
      onCreate(e: RecordEvent) {
        log.push("class");
        return e.next();
      }
    }
    for (const priority of [5, 20])
      app.onRecordCreate(
        "posts",
        (e) => {
          log.push(String(priority));
          return e.next();
        },
        { priority },
      );
    app.register(PostHooks);
    await app.records("posts").create({ title: "a" });
    expect(log).toEqual(["5", "class", "20"]);
  });

  test("a failed collection save fires onCollectionAfterCreateError", async () => {
    const errors: string[] = [];
    app.onCollectionAfterCreateError((e) => {
      errors.push(e.collection.name);
      return e.next();
    });
    const executed: string[] = [];
    app.onCollectionUpdateExecute((e) => {
      executed.push(e.collection.name);
      return e.next();
    });
    await expect(app.collections.save({ name: "posts" })).rejects.toThrow();
    expect(errors).toEqual(["posts"]);
    await app.collections.save({ ...app.collections.find("posts")! });
    expect(executed).toEqual(["posts"]);
  });
});

describe("system handlers", () => {
  test("superusers are verified before the user execute handlers", async () => {
    const seen: unknown[] = [];
    app.onRecordCreateExecute("_superusers", (e) => {
      seen.push(e.record.get("verified"));
      return e.next();
    });
    await app
      .records("_superusers")
      .create({ email: "s@b.co", password: "1234567890" });
    expect(seen).toEqual([true]);
  });

  test("the installer superuser goes through the hooked delete", async () => {
    const superusers = app.records("_superusers");
    await superusers.create({ email: INSTALLER_EMAIL, password: "1234567890" });
    const deleted: unknown[] = [];
    app.onRecordAfterDeleteSuccess("_superusers", (e) => {
      deleted.push(e.record.get("email"));
      return e.next();
    });
    await superusers.create({ email: "s@b.co", password: "1234567890" });
    expect(deleted).toEqual([INSTALLER_EMAIL]);
  });

  test("a password change deletes the MFAs, auth origins and OTPs through the hooked delete", async () => {
    const user = await app
      .records("users")
      .create({ email: "a@b.co", password: "12345678" });
    await addRefs("users", user.id as string);
    const deleted = logDeletes();
    await app
      .records("users")
      .update(user.id as string, { password: "87654321" });
    expect(deleted.sort()).toEqual(["_authOrigins", "_mfas", "_otps"]);
    expect(count("_externalAuths")).toBe(1);
  });

  test("a verified upgrade drops the external auths before the execute handlers", async () => {
    const user = await app
      .records("users")
      .create({ email: "a@b.co", password: "12345678" });
    await addRefs("users", user.id as string);
    const before = internalRecords(app, "users").findRaw(user.id as string);
    const keys: unknown[] = [];
    app.onRecordUpdateExecute(
      "users",
      (e) => {
        keys.push(e.record.get("tokenKey"));
        return e.next();
      },
      { priority: 100 },
    );
    const deleted = logDeletes();
    await app.records("users").update(user.id as string, { verified: true });
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toBe(before.tokenKey);
    expect(deleted.sort()).toEqual(["_externalAuths", "_otps"]);
  });
});

describe("collection import and views", () => {
  test("import saves and deletes through the collection hooks", async () => {
    const log: string[] = [];
    for (const name of [
      "onCollectionCreate",
      "onCollectionUpdate",
      "onCollectionDelete",
    ])
      bind(name, (e: any) => {
        log.push(`${name} ${e.collection.name}`);
        return e.next();
      });
    const posts = app.collections.find("posts")!;
    const users = app.collections.find("users")!;
    await app.collections.import(
      [
        { ...posts, listRule: "" },
        users,
        { name: "tags", type: "base", fields: [text("name")] },
      ] as any,
      true,
    );
    expect(log.sort()).toEqual([
      "onCollectionCreate tags",
      "onCollectionDelete audit",
      "onCollectionUpdate posts",
      "onCollectionUpdate users",
    ]);
  });

  test("import with deleteMissing of an auth collection deletes its rows", async () => {
    await app.collections.save({
      name: "members",
      type: "auth",
      fields: [cheapPassword] as any,
    });
    const m = await app
      .records("members")
      .create({ email: "a@b.co", password: "12345678" });
    await addRefs("members", m.id as string);
    const kept = app.collections.all().filter((c) => c.name !== "members");
    await app.collections.import(kept as any, true);
    expect(app.collections.find("members")).toBeNull();
    for (const table of REFS) expect(count(table)).toBe(0);
  });

  test("a field change that alters a dependent view saves the view through the hooks", async () => {
    await app.collections.save({
      name: "titles",
      type: "view",
      viewQuery: "select id, title from posts",
    });
    const updated: string[] = [];
    app.onCollectionUpdate((e) => {
      updated.push(e.collection.name);
      return e.next();
    });
    const posts = app.collections.find("posts")!;
    await app.collections.save({
      ...posts,
      fields: posts.fields.map((f) =>
        f.name === "title" ? { ...f, max: 10 } : f,
      ),
    });
    expect(updated).toEqual(["posts", "titles"]);
    expect(app.collections.find("titles")!.fields[1]!.max).toBe(10);
  });
});
