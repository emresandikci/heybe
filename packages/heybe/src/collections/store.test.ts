import { beforeEach, describe, expect, test } from "bun:test";
import { type Db, openDb } from "../db";
import { ValidationError } from "../util";
import { CollectionStore } from "./store";
import { collectionId } from "./model";

const now = () => new Date("2026-01-01T00:00:00Z");

let db: Db;
let store: CollectionStore;

const columns = (table: string) =>
  db
    .query<{ name: string }>(`PRAGMA table_info(\`${table}\`)`)
    .map((c) => c.name);

const text = (name: string) => ({ name, type: "text" as const });
const autodate = (name: string, onUpdate: boolean) => ({
  name,
  type: "autodate" as const,
  onCreate: true,
  onUpdate,
});
const postFields = [
  text("title"),
  autodate("created", false),
  autodate("updated", true),
] as any;

function validationData(fn: () => unknown): any {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    return (e as ValidationError).data;
  }
  throw new Error("expected a ValidationError");
}

beforeEach(() => {
  db = openDb(":memory:");
  store = new CollectionStore(db, now);
});

describe("collectionId", () => {
  test("matches PocketBase", () => {
    expect(collectionId("base", "posts")).toBe("pbc_1125843985");
    expect(collectionId("auth", "_superusers")).toBe("pbc_3142635823");
  });
});

describe("bootstrap", () => {
  test("creates the _superusers system collection", () => {
    const su = store.find("_superusers");
    expect(su?.system).toBe(true);
    expect(su?.type).toBe("auth");
    expect(su?.id).toBe("pbc_3142635823");
    expect(columns("_superusers")).toEqual([
      "id",
      "password",
      "tokenKey",
      "email",
      "emailVisibility",
      "verified",
      "created",
      "updated",
    ]);
  });

  test("creates the same system collections and users as a fresh PocketBase", () => {
    expect(store.all().map((c) => c.name)).toEqual([
      "_mfas",
      "_otps",
      "_externalAuths",
      "_authOrigins",
      "_superusers",
      "users",
    ]);
    expect(store.find("users")?.id).toBe("_pb_users_auth_");
  });

  test("is idempotent", () => {
    new CollectionStore(db, now);
    expect(store.all().filter((c) => c.name === "_superusers")).toHaveLength(1);
  });
});

describe("save", () => {
  test("creates the table with id, fields, created, updated", () => {
    const c = store.save({ name: "posts", fields: postFields });
    expect(c.id).toBe("pbc_1125843985");
    expect(c.created).toBe("2026-01-01 00:00:00.000Z");
    expect(columns("posts")).toEqual(["id", "title", "created", "updated"]);
    expect(store.find("posts")).toEqual(c);
    expect(store.find(c.id)).toEqual(c);
  });

  test("a collection with only a title field gets no created and updated columns", () => {
    store.save({ name: "posts", fields: [text("title")] as any });
    expect(columns("posts")).toEqual(["id", "title"]);
  });

  test("adds and drops columns", () => {
    const c = store.save({ name: "posts", fields: postFields });
    const withBody = store.save({
      id: c.id,
      name: "posts",
      fields: [...c.fields, text("body")] as any,
    });
    expect(columns("posts")).toContain("body");
    store.save({
      id: c.id,
      name: "posts",
      fields: withBody.fields.filter((f) => f.name !== "title"),
    });
    expect(columns("posts")).toEqual(["id", "created", "updated", "body"]);
  });

  test("renaming a field keeps row data", () => {
    const c = store.save({ name: "posts", fields: postFields });
    db.run("INSERT INTO posts (id, title) VALUES ('a', 'hello')");
    store.save({
      id: c.id,
      name: "posts",
      fields: c.fields.map((f) =>
        f.name === "title" ? { ...f, name: "heading" } : f,
      ),
    });
    expect(columns("posts")).toContain("heading");
    expect(db.get("SELECT heading FROM posts")).toEqual({ heading: "hello" });
  });

  test("swapping two field names keeps row data", () => {
    const c = store.save({
      name: "posts",
      fields: [text("a"), text("b")] as any,
    });
    db.run("INSERT INTO posts (id, a, b) VALUES ('x', '1', '2')");
    store.save({
      id: c.id,
      name: "posts",
      fields: c.fields.map((f) =>
        f.name === "a"
          ? { ...f, name: "b" }
          : f.name === "b"
            ? { ...f, name: "a" }
            : f,
      ),
    });
    expect(db.get("SELECT a, b FROM posts")).toEqual({ a: "2", b: "1" });
  });

  test("renaming the collection renames the table and keeps rows and indexes", () => {
    const c = store.save({
      name: "posts",
      fields: postFields,
      indexes: ["CREATE INDEX `idx_title` ON `posts` (`title`)"],
    });
    db.run("INSERT INTO posts (id, title) VALUES ('a', 'hello')");
    const renamed = store.save({ id: c.id, name: "articles" });
    expect(db.get("SELECT title FROM articles")).toEqual({ title: "hello" });
    expect(
      db.get("SELECT 1 FROM sqlite_master WHERE name = 'posts'"),
    ).toBeNull();
    expect(renamed.indexes).toEqual([
      "CREATE INDEX `idx_title` ON `articles` (`title`)",
    ]);
    expect(
      db.get<{ tbl_name: string }>(
        "SELECT tbl_name FROM sqlite_master WHERE name = 'idx_title'",
      )?.tbl_name,
    ).toBe("articles");
  });

  test("auth collection gets the system fields and unique indexes", () => {
    const c = store.save({ name: "members", type: "auth" });
    expect(c.fields.filter((f) => f.system).map((f) => f.name)).toEqual([
      "id",
      "password",
      "tokenKey",
      "email",
      "emailVisibility",
      "verified",
    ]);
    expect(c.indexes).toEqual([
      `CREATE UNIQUE INDEX \`idx_tokenKey_${c.id}\` ON \`members\` (\`tokenKey\`)`,
      `CREATE UNIQUE INDEX \`idx_email_${c.id}\` ON \`members\` (\`email\`) WHERE \`email\` != ''`,
    ]);
    expect(columns("members")).toContain("tokenKey");
    expect((c.passwordAuth as any).identityFields).toEqual(["email"]);
    expect(c.authRule).toBe("");
  });

  test("duplicate collection name throws with the name path", () => {
    store.save({ name: "posts" });
    const data = validationData(() => store.save({ name: "Posts" }));
    expect(data.name.code).toBe("validation_collection_name_exists");
  });

  test("invalid field name throws with the field path", () => {
    const data = validationData(() =>
      store.save({
        name: "posts",
        fields: [text("ok"), text("bad name")] as any,
      }),
    );
    expect(data.fields["2"].name.code).toBe("validation_match_invalid");
  });

  test("duplicate field name throws", () => {
    const data = validationData(() =>
      store.save({ name: "posts", fields: [text("a"), text("A")] as any }),
    );
    expect(data.fields["2"].name.code).toBe("validation_duplicated_field_name");
  });

  test("invalid rule throws", () => {
    const data = validationData(() =>
      store.save({ name: "posts", listRule: "title =" }),
    );
    expect(data.listRule.code).toBe("validation_invalid_rule");
  });

  test("invalid collection name throws", () => {
    expect(
      validationData(() => store.save({ name: "bad-name" })).name.code,
    ).toBe("validation_match_invalid");
  });

  test("system collection cannot be renamed or lose system fields", () => {
    const su = store.find("_superusers")!;
    expect(
      validationData(() => store.save({ id: su.id, name: "admins" })).name.code,
    ).toBe("validation_collection_system_name_change");
    const data = validationData(() =>
      store.save({
        id: su.id,
        name: su.name,
        fields: su.fields.filter((f) => f.name !== "created"),
      }),
    );
    expect(data.fields.code).toBe("validation_system_field_change");
  });

  test("type cannot change", () => {
    const c = store.save({ name: "posts" });
    expect(
      validationData(() =>
        store.save({ id: c.id, name: "posts", type: "auth" }),
      ).type.code,
    ).toBe("validation_collection_type_change");
  });

  test("failed save leaves the db untouched", () => {
    const c = store.save({ name: "posts", fields: postFields });
    expect(() =>
      store.save({
        id: c.id,
        name: "posts",
        indexes: ["CREATE INDEX `i` ON `posts` (`nope`)"],
      }),
    ).toThrow();
    expect(store.find("posts")).toEqual(c);
    expect(columns("posts")).toEqual(["id", "title", "created", "updated"]);
  });
});

describe("delete and truncate", () => {
  test("delete drops the table and the row", () => {
    store.save({ name: "posts" });
    store.delete("posts");
    expect(store.find("posts")).toBeNull();
    expect(
      db.get("SELECT 1 FROM sqlite_master WHERE name = 'posts'"),
    ).toBeNull();
  });

  test("delete on a system collection throws", () => {
    expect(() => store.delete("_superusers")).toThrow(
      "[_superusers] system collections cannot be deleted",
    );
    expect(store.find("_superusers")).not.toBeNull();
  });
});

describe("validation parity with PocketBase", () => {
  test("a rule is parsed and resolved against the collection fields", () => {
    const rule = (listRule: string) =>
      validationData(() =>
        store.save({ name: "posts", fields: [text("title")] as any, listRule }),
      ).listRule?.message;
    expect(rule("title =")).toBe(
      "Invalid rule. Raw error: invalid or incomplete filter expression.",
    );
    expect(rule("nope = 1")).toBe(
      'Invalid rule. Raw error: invalid left operand "nope" - unknown field "nope".',
    );
    expect(() =>
      store.save({
        name: "ok",
        fields: [text("title")] as any,
        listRule: "title != ''",
      }),
    ).not.toThrow();
  });

  test("create with an existing id is a validation error, not an update", () => {
    store.save({ name: "posts", id: "customid1234567" });
    const data = validationData(() =>
      store.save({ name: "other", id: "customid1234567" }, true),
    );
    expect(data.id.code).toBe("validation_invalid_or_existing_id");
  });

  test("the superusers collection keeps password auth on and OAuth2 off", () => {
    const su = store.find("_superusers")!;
    store.save({
      ...su,
      passwordAuth: { enabled: false, identityFields: ["email"] },
      oauth2: { ...(su.oauth2 as object), enabled: false, providers: [] },
    } as any);
    expect((store.find("_superusers")!.passwordAuth as any).enabled).toBe(true);
  });

  test("an autogenerate pattern that breaks the field limits is rejected", () => {
    const data = validationData(() =>
      store.save({
        name: "posts",
        fields: [
          {
            name: "code",
            type: "text",
            max: 5,
            autogeneratePattern: "[a-z]{10}",
          },
        ] as any,
      }),
    );
    expect(data.fields[1].autogeneratePattern.code).toBe(
      "validation_invalid_autogenerate_pattern_value",
    );
  });

  test("a system field with the wrong type is replaced", () => {
    const c = store.save({
      name: "people",
      type: "auth",
      fields: [text("email")] as any,
    });
    expect(c.fields.find((f) => f.name === "email")?.type).toBe("email");
  });
});
