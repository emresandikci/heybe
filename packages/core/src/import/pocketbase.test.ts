import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { App } from "../app";
import { authFromToken } from "../auth/tokens";
import { signJwt } from "../auth/jwt";
import { testApp } from "../test-app";
import { INSTALLER_EMAIL } from "../util";
import {
  PB_DEFAULT_SETTINGS,
  PB_SYSTEM_COLLECTIONS,
  encryptLikePb,
  writePbDataDir,
} from "./pb-fixture";
import { importPocketBase } from "./pocketbase";

type Obj = Record<string, unknown>;

const KEY = "abcdefghijklmnopqrstuvwxyz012345";
const DATE = "2024-05-06 07:08:09.123Z";

const pbUsers = PB_SYSTEM_COLLECTIONS.find((c) => c.name === "users")!;
const pbSuperusers = PB_SYSTEM_COLLECTIONS.find(
  (c) => c.name === "_superusers",
)!;
const idField = JSON.parse(String(pbUsers.fields)).find(
  (f: Obj) => f.name === "id",
);
const field = (id: string, name: string, type: string, extra: Obj = {}) => ({
  id,
  name,
  type,
  system: false,
  hidden: false,
  presentable: false,
  required: false,
  ...extra,
});

const posts = {
  id: "pbc_posts00001",
  name: "posts",
  type: "base",
  system: false,
  listRule: "",
  viewRule: "@request.auth.id != ''",
  createRule: null,
  updateRule: null,
  deleteRule: null,
  indexes: ["CREATE UNIQUE INDEX `idx_posts_title` ON `posts` (`title`)"],
  fields: [
    idField,
    field("text1", "title", "text", { min: 0, max: 0, pattern: "" }),
    field("number1", "views", "number", { onlyInt: false }),
    field("bool1", "draft", "bool"),
    field("json1", "meta", "json", { maxSize: 0 }),
    field("select1", "tags", "select", {
      values: ["a", "b", "c"],
      maxSelect: 3,
    }),
    field("relation1", "authors", "relation", {
      collectionId: "_pb_users_auth_",
      cascadeDelete: false,
      minSelect: 0,
      maxSelect: 5,
    }),
    field("date1", "published", "date", { min: "", max: "" }),
    field("file1", "images", "file", {
      maxSelect: 3,
      maxSize: 0,
      mimeTypes: [],
      thumbs: ["2x2"],
      protected: false,
    }),
    field("geo1", "place", "geoPoint"),
    field("autodate1", "created", "autodate", {
      onCreate: true,
      onUpdate: false,
    }),
    field("autodate2", "updated", "autodate", {
      onCreate: true,
      onUpdate: true,
    }),
  ],
};

const titles = {
  id: "pbc_titles0001",
  name: "post_titles",
  type: "view",
  system: false,
  listRule: "",
  viewRule: "",
  createRule: null,
  updateRule: null,
  deleteRule: null,
  indexes: [],
  viewQuery: "SELECT id, title FROM posts",
  fields: [
    idField,
    field("text2", "title", "text", { min: 0, max: 0, pattern: "" }),
  ],
};

const postRow = {
  id: "post00000000001",
  title: "Merhaba",
  views: 1.5,
  draft: true,
  meta: { a: [1, 2] },
  tags: ["a", "c"],
  authors: ["user00000000001"],
  published: DATE,
  images: ["a_abc123.png", "b_def456.png"],
  place: { lon: 28.97, lat: 41.01 },
  created: DATE,
  updated: DATE,
};

const userRow = {
  id: "user00000000001",
  email: "ayse@example.com",
  emailVisibility: true,
  verified: true,
  name: "Ayşe",
  avatar: "",
  password: "$2a$10$abcdefghijklmnopqrstuuJ7h1x4qK5Z1rQ5v2lF0n7bY3gZpC9e.",
  tokenKey: "tokenkeyuser1",
  created: DATE,
  updated: DATE,
};

const ref = (table: string, id: string, extra: Obj = {}) => ({
  id,
  collectionRef: "_pb_users_auth_",
  recordRef: "user00000000001",
  created: DATE,
  updated: DATE,
  ...extra,
});

let app: App;
let dir: string;
let pbDir: string;

beforeEach(() => {
  app = testApp({ argv: [] });
  dir = mkdtempSync(join(tmpdir(), "hb-import-"));
  pbDir = join(dir, "pb_data");
});

afterEach(() => {
  app.close();
  rmSync(dir, { recursive: true, force: true });
});

const raw = (sql: string) => app.db.query<Obj>(sql);
const storage = () => join(app.dataDir, "storage");

describe("importPocketBase", () => {
  test("imports a base, auth and view collection with ids, rules, indexes and token secrets", async () => {
    const options = JSON.parse(String(pbUsers.options));
    writePbDataDir(pbDir, {
      collections: [posts, titles],
      rows: { users: [userRow], posts: [postRow] },
    });
    await importPocketBase(app, pbDir);

    const imported = app.collections.find("hbc_posts00001")!;
    expect(imported.name).toBe("posts");
    expect(imported.viewRule).toBe("@request.auth.id != ''");
    expect(imported.createRule).toBeNull();
    expect(imported.indexes).toEqual(posts.indexes);
    expect(imported.fields.map((f) => [f.id, f.name, f.type])).toEqual(
      posts.fields.map((f) => [f.id, f.name, f.type]),
    );

    const users = app.collections.find("_hb_users_auth_") as unknown as Obj;
    for (const key of [
      "authToken",
      "passwordResetToken",
      "emailChangeToken",
      "verificationToken",
      "fileToken",
    ])
      expect(users[key]).toEqual(options[key]);
    const su = app.collections.find("_superusers") as unknown as Obj;
    expect(su.authToken).toEqual(
      JSON.parse(String(pbSuperusers.options)).authToken,
    );

    expect(app.collections.find("hbc_titles0001")?.type).toBe("view");
    expect(raw("SELECT id, title FROM post_titles")).toEqual([
      { id: postRow.id, title: "Merhaba" },
    ]);
  });

  test("rewrites pb ids to hb ones, keeping relations, files and PocketBase tokens working", async () => {
    const superuser = {
      id: "super0000000001",
      email: "root@example.com",
      password: userRow.password,
      tokenKey: "tokenkeysuper1",
    };
    writePbDataDir(pbDir, {
      collections: [posts],
      rows: { users: [userRow], posts: [postRow], _superusers: [superuser] },
      files: {
        "pbc_posts00001/post00000000001/a_abc123.png": "png-a",
        "_pb_users_auth_/user00000000001/avatar.png": "png-u",
      },
    });
    await importPocketBase(app, pbDir);

    const ids = app.collections.all().map((c) => c.id);
    expect(ids).toContain("hbc_3142635823");
    expect(ids).toContain("_hb_users_auth_");
    expect(ids).toContain("hbc_posts00001");
    expect(ids.filter((id) => /^(pbc_|_pb_)/.test(id))).toEqual([]);

    const authors = app.collections
      .find("posts")!
      .fields.find((f) => f.name === "authors")!;
    expect(authors.collectionId).toBe("_hb_users_auth_");
    expect(app.collections.find(String(authors.collectionId))?.name).toBe(
      "users",
    );

    expect(
      await app.files.exists("hbc_posts00001/post00000000001/a_abc123.png"),
    ).toBe(true);
    expect(
      await app.files.exists("_hb_users_auth_/user00000000001/avatar.png"),
    ).toBe(true);

    const pbToken = (pbCollection: Obj, collectionId: string, row: Obj) =>
      signJwt(
        {
          type: "auth",
          id: row.id,
          collectionId,
          refreshable: true,
          exp: Math.floor(app.now().getTime() / 1000) + 60,
        },
        `${row.tokenKey}${JSON.parse(String(pbCollection.options)).authToken.secret}`,
      );
    expect(
      authFromToken(app, pbToken(pbUsers, "_pb_users_auth_", userRow))?.record
        .id,
    ).toBe(userRow.id);
    const su = authFromToken(
      app,
      pbToken(pbSuperusers, "pbc_3142635823", superuser),
    );
    expect(su?.isSuperuser).toBe(true);
  });

  test("copies rows of every field type verbatim", async () => {
    writePbDataDir(pbDir, {
      collections: [posts],
      rows: { users: [userRow], posts: [postRow] },
    });
    await importPocketBase(app, pbDir);
    expect(raw("SELECT * FROM posts")).toEqual([
      {
        ...postRow,
        draft: 1,
        meta: JSON.stringify(postRow.meta),
        tags: JSON.stringify(postRow.tags),
        authors: JSON.stringify(postRow.authors),
        images: JSON.stringify(postRow.images),
        place: JSON.stringify(postRow.place),
      },
    ]);
    expect(raw("SELECT * FROM users")).toEqual([
      { ...userRow, emailVisibility: 1, verified: 1 },
    ]);
  });

  test("copies _superusers, _externalAuths, _mfas, _otps and _authOrigins rows", async () => {
    await app.records("_superusers").create({
      email: INSTALLER_EMAIL,
      password: "1234567890",
    });
    const superuser = {
      id: "super0000000001",
      email: "root@example.com",
      emailVisibility: false,
      verified: true,
      password: "$2a$10$abcdefghijklmnopqrstuuJ7h1x4qK5Z1rQ5v2lF0n7bY3gZpC9e.",
      tokenKey: "tokenkeysuper1",
      created: DATE,
      updated: DATE,
    };
    const rows = {
      users: [userRow],
      _superusers: [superuser],
      _externalAuths: [
        ref("_externalAuths", "ext000000000001", {
          provider: "github",
          providerId: "42",
        }),
      ],
      _mfas: [ref("_mfas", "mfa000000000001", { method: "password" })],
      _otps: [
        ref("_otps", "otp000000000001", {
          password: "$2a$10$otp",
          sentTo: "ayse@example.com",
        }),
      ],
      _authOrigins: [
        ref("_authOrigins", "ori000000000001", { fingerprint: "abc" }),
      ],
    };
    writePbDataDir(pbDir, { rows });
    const summary = await importPocketBase(app, pbDir);
    expect(raw("SELECT * FROM _superusers")).toEqual([
      { ...superuser, emailVisibility: 0, verified: 1 },
    ]);
    for (const table of ["_externalAuths", "_mfas", "_otps", "_authOrigins"])
      expect(raw(`SELECT * FROM ${table}`)).toEqual(
        rows[table as keyof typeof rows].map((r) => ({
          ...r,
          collectionRef: "_hb_users_auth_",
        })),
      );
    expect(summary).toEqual({ collections: 6, records: 6, files: 0 });
  });

  test("columns only one side has are skipped", async () => {
    writePbDataDir(pbDir, { rows: { users: [userRow] } });
    const pb = new Database(join(pbDir, "data.db"));
    pb.run("ALTER TABLE users ADD COLUMN extra TEXT DEFAULT 'x' NOT NULL");
    pb.run("ALTER TABLE users DROP COLUMN name");
    pb.close();
    await importPocketBase(app, pbDir);
    expect(raw("SELECT * FROM users")).toEqual([
      { ...userRow, name: "", emailVisibility: 1, verified: 1 },
    ]);
  });

  test("imports plain and encrypted settings", async () => {
    const settings = structuredClone(PB_DEFAULT_SETTINGS) as {
      meta: Obj;
      smtp: Obj;
    };
    settings.meta.appName = "Dükkan";
    settings.smtp.password = "smtp-secret";

    writePbDataDir(pbDir, { settings });
    await importPocketBase(app, pbDir);
    expect(app.settings.get().meta.appName).toBe("Dükkan");
    expect(app.settings.get().smtp.password).toBe("smtp-secret");

    const encrypted = testApp({ argv: [] });
    try {
      const encDir = join(dir, "pb_enc");
      writePbDataDir(encDir, {
        settings: encryptLikePb(JSON.stringify(settings), KEY),
      });
      await importPocketBase(encrypted, encDir, { encryptionKey: KEY });
      expect(encrypted.settings.get().meta.appName).toBe("Dükkan");
      expect(encrypted.settings.get().smtp.password).toBe("smtp-secret");
    } finally {
      encrypted.close();
    }
  });

  test("copies storage files unless s3 is enabled", async () => {
    const files = {
      "pbc_posts00001/post00000000001/a_abc123.png": "png-a",
      "pbc_posts00001/post00000000001/b_def456.png": "png-b",
      "pbc_posts00001/post00000000001/thumbs_a_abc123.png/2x2_a_abc123.png":
        "thumb",
    };
    writePbDataDir(pbDir, {
      collections: [posts],
      rows: { users: [userRow], posts: [postRow] },
      files,
    });
    expect(await importPocketBase(app, pbDir)).toEqual({
      collections: 7,
      records: 2,
      files: 2,
    });
    for (const [path, content] of Object.entries(files))
      expect(
        readFileSync(join(storage(), path.replace("pbc_", "hbc_")), "utf8"),
      ).toBe(content);

    const s3 = testApp({ argv: [] });
    try {
      const s3Dir = join(dir, "pb_s3");
      const settings = structuredClone(PB_DEFAULT_SETTINGS) as { s3: Obj };
      settings.s3 = {
        ...settings.s3,
        enabled: true,
        bucket: "b",
        region: "r",
        endpoint: "https://s3.example.com",
        accessKey: "k",
        secret: "s",
      };
      writePbDataDir(s3Dir, { settings, files });
      expect((await importPocketBase(s3, s3Dir)).files).toBe(0);
      expect(existsSync(join(s3.dataDir, "storage"))).toBe(false);
    } finally {
      s3.close();
    }
  });

  test("refuses a non-empty Heybe dir, a missing data.db, a non-PB db, a pre-v0.23 db and encrypted settings without a key, leaving the Heybe dir unchanged", async () => {
    const snapshot = () => ({
      collections: raw("SELECT * FROM _collections ORDER BY id"),
      params: raw("SELECT * FROM _params"),
      users: raw("SELECT * FROM users"),
      storage: existsSync(storage()) ? readdirSync(storage()) : [],
    });
    const failure = (pbPath: string, opts?: { encryptionKey?: string }) =>
      importPocketBase(app, pbPath, opts).then(
        () => "",
        (e: Error) => e.message,
      );

    writePbDataDir(pbDir, {
      collections: [posts],
      rows: { users: [userRow] },
      settings: encryptLikePb(JSON.stringify(PB_DEFAULT_SETTINGS), KEY),
      files: { "x/y/z.txt": "z" },
    });
    const before = snapshot();

    const empty = join(dir, "empty");
    mkdirSync(empty);
    expect(await failure(empty)).toBe(
      `"${empty}" is not a PocketBase data directory: data.db is missing`,
    );
    const other = join(dir, "other");
    mkdirSync(other);
    const otherDb = new Database(join(other, "data.db"));
    otherDb.run("CREATE TABLE t (a)");
    otherDb.close();
    expect(await failure(other)).toBe(
      `"${other}" is not a PocketBase data directory: _collections is missing`,
    );
    const old = join(dir, "old");
    mkdirSync(old);
    const oldDb = new Database(join(old, "data.db"));
    oldDb.run("CREATE TABLE _collections (id, name, schema)");
    oldDb.close();
    expect(await failure(old)).toBe(
      `"${old}" was created by PocketBase older than v0.23, which is not supported: start PocketBase v0.23 or newer on it once to upgrade it, then import`,
    );
    expect(await failure(pbDir)).toBe(
      "the PocketBase settings are encrypted, pass --encryptionEnv with the name of the variable that holds the key",
    );
    expect(
      await failure(pbDir, {
        encryptionKey: "bcdefghijklmnopqrstuvwxyz0123456",
      }),
    ).toStartWith("failed to decrypt the PocketBase settings: ");
    expect(snapshot()).toEqual(before);

    await app.records("users").create({
      email: "x@example.com",
      password: "1234567890",
      passwordConfirm: "1234567890",
    });
    const withUser = snapshot();
    expect(await failure(pbDir, { encryptionKey: KEY })).toBe(
      `the Heybe data directory "${app.dataDir}" is not empty, import needs a fresh one`,
    );
    expect(snapshot()).toEqual(withUser);

    const fresh = testApp({ argv: [] });
    try {
      mkdirSync(join(fresh.dataDir, "storage"));
      writeFileSync(join(fresh.dataDir, "storage", "left.txt"), "x");
      expect(
        await importPocketBase(fresh, pbDir, { encryptionKey: KEY }).then(
          () => "",
          (e: Error) => e.message,
        ),
      ).toEndWith("is not empty, import needs a fresh one");
      expect(fresh.collections.find("posts")).toBeNull();
    } finally {
      fresh.close();
    }
  });

  test("leaves the PocketBase dir untouched", async () => {
    writePbDataDir(pbDir, { rows: { users: [userRow] } });
    const pb = new Database(join(pbDir, "data.db"));
    pb.run("PRAGMA wal_autocheckpoint = 0");
    pb.run("UPDATE users SET name = 'from wal'");
    const listing = () =>
      readdirSync(pbDir).map((f) => [f, readFileSync(join(pbDir, f), "hex")]);
    const before = listing();
    await importPocketBase(app, pbDir);
    expect(listing()).toEqual(before);
    pb.close();
    expect(raw("SELECT name FROM users")).toEqual([{ name: "from wal" }]);
  });

  test("PocketBase collections replace the Heybe defaults", async () => {
    const people = {
      ...pbUsers,
      ...JSON.parse(String(pbUsers.options)),
      id: "pbc_people0001",
      fields: JSON.parse(String(pbUsers.fields)),
      indexes: [],
      options: undefined,
    };
    writePbDataDir(pbDir, { collections: [people] });
    await importPocketBase(app, pbDir);
    expect(app.collections.find("_hb_users_auth_")).toBeNull();
    expect(app.collections.find("users")?.id).toBe("hbc_people0001");

    const second = testApp({ argv: [] });
    try {
      const noUsers = join(dir, "pb_no_users");
      writePbDataDir(noUsers, {});
      const db = new Database(join(noUsers, "data.db"));
      db.run("DELETE FROM _collections WHERE id = '_pb_users_auth_'");
      db.run("DROP TABLE users");
      db.close();
      expect((await importPocketBase(second, noUsers)).collections).toBe(5);
      expect(second.collections.find("users")).toBeNull();
    } finally {
      second.close();
    }
  });

  test("a failing database import removes the copied storage files", async () => {
    writePbDataDir(pbDir, {
      collections: [
        {
          ...posts,
          fields: posts.fields.map((f) =>
            f.name === "authors" ? { ...f, collectionId: "missing" } : f,
          ),
        },
      ],
      files: { "a/b/c.txt": "c" },
    });
    const collections = raw("SELECT * FROM _collections ORDER BY id");
    expect(
      await importPocketBase(app, pbDir).then(
        () => "",
        (e: Error) => e.message,
      ),
    ).not.toBe("");
    expect(existsSync(storage())).toBe(false);
    expect(raw("SELECT * FROM _collections ORDER BY id")).toEqual(collections);
  });
});
