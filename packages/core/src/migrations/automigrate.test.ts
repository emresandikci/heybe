import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App } from "../app";
import { testApp } from "../test-app";
import { newAuthToken } from "../auth/tokens";
import type { Collection } from "../collections/model";
import { migrateCommand } from "../commands/migrate";
import { loadAuth } from "../http/middlewares";
import { createEvent } from "../http/router";
import { createRouter } from "../http/server";
import { internalRecords } from "../records/internal";
import {
  addFieldAt,
  bindAutomigrate,
  mergeCollection,
  removeFieldById,
} from "./automigrate";
import type { Io } from "./runner";

const INDEX = JSON.stringify(join(import.meta.dir, "..", "index.ts"));
const T0 = 1_700_000_000_000;

const dirs: string[] = [];
const apps: App[] = [];
let clock: number;
let lines: string[];

const io: Io = {
  out: (line) => lines.push(line),
  confirm: async () => true,
};

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "hb-automigrate-"));
  dirs.push(d);
  return d;
}

function newApp(migrationsDir = tempDir(), automigrate = true): App {
  const app = testApp({ migrationsDir, now: () => new Date(clock), argv: [] });
  apps.push(app);
  if (automigrate) bindAutomigrate(app);
  return app;
}

const tokens = new Map<App, string>();

async function token(app: App): Promise<string> {
  if (!tokens.has(app)) {
    const records = internalRecords(app, "_superusers");
    const su = await records.create({
      email: "su@example.com",
      password: "1234567890",
    });
    tokens.set(
      app,
      newAuthToken(
        app,
        app.collections.find("_superusers")!,
        records.findRaw(su.id as string),
      ),
    );
  }
  return tokens.get(app)!;
}

async function call(app: App, method: string, path: string, body?: unknown) {
  const req = new Request(`http://x${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: await token(app),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const found = createRouter()
    .build()
    .match(method, new URL(req.url).pathname)!;
  const e = createEvent(app, req, found.params);
  e.auth = loadAuth(app, req);
  try {
    const res = await found.run(e);
    return { status: res.status, body: await res.text() };
  } catch (err) {
    return { status: (err as { status: number }).status, body: "" };
  }
}

const files = (app: App) => readdirSync(app.migrationsDir).sort();
const read = (app: App, file: string) =>
  readFileSync(join(app.migrationsDir, file), "utf8");
const rows = (app: App) =>
  app.db
    .query<{ file: string; applied: number }>(
      "SELECT file, applied FROM _migrations ORDER BY file",
    )
    .map((r) => [r.file, r.applied]);

beforeEach(() => {
  clock = T0;
  lines = [];
});

afterEach(() => {
  for (const app of apps.splice(0)) app.close();
  tokens.clear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tables = (app: App) =>
  app.db.get("SELECT 1 AS x FROM sqlite_master WHERE name = '_migrations'")
    ? rows(app)
    : [];

// generated files import "@heybejs/core", which does not resolve from a temp dir
function resolveImports(dir: string) {
  for (const f of readdirSync(dir))
    writeFileSync(
      join(dir, f),
      readFileSync(join(dir, f), "utf8").replace(
        'from "@heybejs/core"',
        `from ${INDEX}`,
      ),
    );
}

const migrate = (app: App, ...args: string[]) => migrateCommand(args, app, io);

// the collections API body without timestamps
async function collectionsBody(app: App) {
  const res = await call(app, "GET", "/api/collections?perPage=100");
  const items = (JSON.parse(res.body) as { items: Record<string, unknown>[] })
    .items;
  return items.map(({ created, updated, ...rest }) => rest);
}

function plain(c: Collection | null) {
  const { created, updated, ...rest } = c!;
  return rest;
}

const TITLE_FIELD = `{
        "autogeneratePattern": "",
        "help": "",
        "hidden": false,
        "id": "text724990059",
        "max": 0,
        "min": 0,
        "name": "title",
        "pattern": "",
        "presentable": false,
        "primaryKey": false,
        "required": false,
        "system": false,
        "type": "text"
      }`;

const POSTS_JSON = `{
    "createRule": null,
    "deleteRule": null,
    "fields": [
      {
        "autogeneratePattern": "[a-z0-9]{15}",
        "help": "",
        "hidden": false,
        "id": "text3208210256",
        "max": 15,
        "min": 15,
        "name": "id",
        "pattern": "^[a-z0-9]+$",
        "presentable": false,
        "primaryKey": true,
        "required": true,
        "system": true,
        "type": "text"
      },
      ${TITLE_FIELD}
    ],
    "id": "hbc_1125843985",
    "indexes": [],
    "listRule": null,
    "name": "posts",
    "system": false,
    "type": "base",
    "updateRule": null,
    "viewRule": null
  }`;

const createPosts = (app: App) =>
  call(app, "POST", "/api/collections", {
    name: "posts",
    fields: [{ name: "title", type: "text" }],
  });

describe("automigrate through the collection routes", () => {
  test("a create writes the created file and its row", async () => {
    const app = newApp();
    expect((await createPosts(app)).status).toBe(200);
    expect(files(app)).toEqual(["1700000000_created_posts.ts"]);
    expect(read(app, "1700000000_created_posts.ts")).toBe(
      `import { migrate, newCollection } from "@heybejs/core";

export default migrate(async (app) => {
  const collection = newCollection(${POSTS_JSON});

  await app.collections.save(collection, true);
}, async (app) => {
  await app.collections.delete("hbc_1125843985");
});
`,
    );
    expect(tables(app)).toEqual([
      ["1700000000_created_posts.ts", 1_700_000_000_000_000],
    ]);
  });

  test("a delete writes the deleted file and its row", async () => {
    const app = newApp();
    await createPosts(app);
    clock += 1000;
    expect((await call(app, "DELETE", "/api/collections/posts")).status).toBe(
      204,
    );
    expect(read(app, "1700000001_deleted_posts.ts")).toBe(
      `import { migrate, newCollection } from "@heybejs/core";

export default migrate(async (app) => {
  await app.collections.delete("hbc_1125843985");
}, async (app) => {
  const collection = newCollection(${POSTS_JSON});

  await app.collections.save(collection, true);
});
`,
    );
    expect(tables(app)).toEqual([
      ["1700000000_created_posts.ts", 1_700_000_000_000_000],
      ["1700000001_deleted_posts.ts", 1_700_000_001_000_000],
    ]);
  });

  test("a name ending in test gets a trailing underscore", async () => {
    const app = newApp();
    await call(app, "POST", "/api/collections", { name: "MyTest" });
    expect(files(app)).toEqual(["1700000000_created_MyTest_.ts"]);
  });

  test("a create rejected by validation writes no file and no row", async () => {
    const app = newApp();
    const res = await call(app, "POST", "/api/collections", {
      name: "posts",
      fields: [{ name: "id", type: "bool" }],
    });
    expect(res.status).toBe(400);
    expect(files(app)).toEqual([]);
    expect(tables(app)).toEqual([]);
    expect(app.collections.find("posts")).toBeNull();
  });

  test("a no-op update and a field reorder write nothing", async () => {
    const app = newApp();
    await call(app, "POST", "/api/collections", {
      name: "posts",
      fields: [
        { name: "title", type: "text" },
        { name: "count", type: "number" },
      ],
    });
    clock += 1000;
    expect(
      (await call(app, "PATCH", "/api/collections/posts", {})).status,
    ).toBe(200);
    const fields = app.collections.find("posts")!.fields;
    const res = await call(app, "PATCH", "/api/collections/posts", {
      fields: [fields[0], fields[2], fields[1]],
    });
    expect(res.status).toBe(200);
    expect(app.collections.find("posts")!.fields[1]!.name).toBe("count");
    expect(files(app)).toEqual(["1700000000_created_posts.ts"]);
  });
});

const field = (props: string, indent = "  ") =>
  `{\n${props
    .trim()
    .split("\n")
    .map((l) => `${indent}  ${l.trim()}`)
    .join("\n")}\n${indent}}`;

const TEXT_PROPS = (id: string, name: string) => `"autogeneratePattern": "",
  "help": "",
  "hidden": false,
  "id": "${id}",
  "max": 0,
  "min": 0,
  "name": "${name}",
  "pattern": "",
  "presentable": false,
  "primaryKey": false,
  "required": false,
  "system": false,
  "type": "text"`;

const COUNT_PROPS = (max: string) => `"help": "",
  "hidden": false,
  "id": "number2245608546",
  "max": ${max},
  "min": null,
  "name": "count",
  "onlyInt": false,
  "presentable": false,
  "required": false,
  "system": false,
  "type": "number"`;

const UPDATE_FILE = `import { addFieldAt, mergeCollection, migrate, removeFieldById } from "@heybejs/core";

export default migrate(async (app) => {
  const collection = app.collections.require("hbc_1125843985");

  // update collection data
  mergeCollection(collection, {
    "listRule": ""
  });

  // remove field
  removeFieldById(collection, "text724990059");

  // add field
  addFieldAt(collection, 2, ${field(TEXT_PROPS("text3685223346", "body"))});

  // update field
  addFieldAt(collection, 1, ${field(COUNT_PROPS("10"))});

  await app.collections.save(collection);
}, async (app) => {
  const collection = app.collections.require("hbc_1125843985");

  // update collection data
  mergeCollection(collection, {
    "listRule": null
  });

  // add field
  addFieldAt(collection, 1, ${field(TEXT_PROPS("text724990059", "title"))});

  // remove field
  removeFieldById(collection, "text3685223346");

  // update field
  addFieldAt(collection, 2, ${field(COUNT_PROPS("null"))});

  await app.collections.save(collection);
});
`;

async function createPostsWithCount(app: App) {
  await call(app, "POST", "/api/collections", {
    name: "posts",
    fields: [
      { name: "title", type: "text" },
      { name: "count", type: "number" },
    ],
  });
}

describe("update migrations", () => {
  test("only the changed parts are written, and down restores the old collection", async () => {
    const app = newApp();
    await createPostsWithCount(app);
    const before = plain(app.collections.find("posts"));
    clock += 1000;
    const [id, , count] = app.collections.find("posts")!.fields;
    const res = await call(app, "PATCH", "/api/collections/posts", {
      listRule: "",
      fields: [id, { ...count, max: 10 }, { name: "body", type: "text" }],
    });
    expect(res.status).toBe(200);
    expect(read(app, "1700000001_updated_posts.ts")).toBe(UPDATE_FILE);
    expect(tables(app).map((r) => r[0])).toEqual([
      "1700000000_created_posts.ts",
      "1700000001_updated_posts.ts",
    ]);

    resolveImports(app.migrationsDir);
    clock += 1000;
    await migrate(app, "down", "1");
    expect(lines).toEqual(["Reverted 1700000001_updated_posts.ts"]);
    expect(plain(app.collections.find("posts"))).toEqual(before);
  });

  test("two branches changing different fields of the same base merge in either order", async () => {
    const base = newApp();
    await createPostsWithCount(base);
    const [id, title, count] = base.collections.find("posts")!.fields;
    clock += 1000;
    await call(base, "PATCH", "/api/collections/posts", {
      fields: [id, { ...title, max: 50 }, count],
    });
    resolveImports(base.migrationsDir);
    await migrate(base, "down", "1");
    clock += 1000;
    await call(base, "PATCH", "/api/collections/posts", {
      viewRule: "",
      fields: [id, title, count, { name: "body", type: "text" }],
    });
    resolveImports(base.migrationsDir);
    const src = (f: string) => read(base, f);
    const created = src("1700000000_created_posts.ts");
    const branchA = src("1700000001_updated_posts.ts");
    const branchB = src("1700000002_updated_posts.ts");

    for (const order of [
      [branchA, branchB],
      [branchB, branchA],
    ]) {
      const dir = tempDir();
      writeFileSync(join(dir, "1_created.ts"), created);
      writeFileSync(join(dir, "2_updated.ts"), order[0]!);
      writeFileSync(join(dir, "3_updated.ts"), order[1]!);
      const app = newApp(dir, false);
      await migrate(app, "up");
      const posts = app.collections.find("posts")!;
      expect(posts.viewRule).toBe("");
      expect(posts.fields.map((f) => [f.name, f.max])).toEqual([
        ["id", 15],
        ["title", 50],
        ["count", null],
        ["body", 0],
      ]);
    }
  });
});

describe("generated files on a fresh data dir", () => {
  test("migrate up on the automigrate files yields the same collections", async () => {
    const app = newApp();
    const step = async (method: string, path: string, body?: unknown) => {
      clock += 1000;
      expect((await call(app, method, path, body)).status).toBeLessThan(300);
    };
    await step("POST", "/api/collections", {
      name: "posts",
      fields: [{ name: "title", type: "text" }],
    });
    await step("POST", "/api/collections", {
      name: "members",
      type: "auth",
      listRule: "id = @request.auth.id",
      fields: [{ name: "nick", type: "text" }],
      passwordAuth: { identityFields: ["email"] },
      oauth2: {
        enabled: true,
        providers: [
          { name: "google", clientId: "cid", clientSecret: "topsecret" },
        ],
      },
    });
    const posts = app.collections.find("posts")!;
    const members = app.collections.find("members")!;
    await step("PATCH", "/api/collections/posts", {
      listRule: "",
      indexes: ["CREATE INDEX idx_title ON posts (title)"],
      fields: [
        ...posts.fields,
        {
          name: "author",
          type: "relation",
          collectionId: members.id,
          maxSelect: 1,
        },
      ],
    });
    await step("PATCH", "/api/collections/members", {
      otp: { enabled: true },
    });
    await step("POST", "/api/collections", { name: "tmp" });
    await step("DELETE", "/api/collections/tmp");
    await step("PATCH", "/api/collections/posts", { name: "articles" });
    await step("POST", "/api/collections", {
      name: "titles",
      type: "view",
      viewQuery: "SELECT id, title FROM articles",
    });
    await step("PATCH", "/api/collections/titles", {
      viewQuery: "SELECT id, title, author FROM articles",
    });
    expect(files(app)).toHaveLength(9);
    for (const f of files(app)) expect(read(app, f)).not.toMatch(/secret/i);

    resolveImports(app.migrationsDir);
    const fresh = newApp(app.migrationsDir);
    await migrate(fresh, "up");
    expect(lines).toHaveLength(9);
    // like PB, oauth2 providers stay out of migrations and view field ids are random per save
    const comparable = async (a: App) =>
      JSON.stringify(await collectionsBody(a))
        .replace(/"providers":\[[^\]]*\]/g, '"providers":[]')
        .replace(/_clone_\w+/g, "_clone_");
    expect(await comparable(fresh)).toBe(await comparable(app));

    const before = files(fresh);
    clock += 1000;
    const res = await call(fresh, "PUT", "/api/collections/import", {
      collections: [{ name: "imported" }],
    });
    expect(res.status).toBe(204);
    expect(files(fresh)).toEqual(before);
  });

  test("migrate collections writes a snapshot that a fresh dir applies", async () => {
    const app = newApp(tempDir(), false);
    await app.collections.save({
      name: "posts",
      listRule: "",
      fields: [{ name: "title", type: "text" }] as Collection["fields"],
    });
    await app.collections.save({
      name: "members",
      type: "auth",
      fields: [{ name: "nick", type: "text" }] as Collection["fields"],
    });
    await migrate(app, "collections");
    const file = join(app.migrationsDir, "1700000000_collections_snapshot.ts");
    expect(lines).toEqual([
      `Successfully created file ${JSON.stringify(file)}`,
    ]);
    expect(readFileSync(file, "utf8")).toStartWith(
      `import { importCollections, migrate } from "@heybejs/core";

export default migrate(async (app) => {
  const snapshot = [
    {`,
    );
    expect(tables(app)).toEqual([]);

    resolveImports(app.migrationsDir);
    const fresh = newApp(app.migrationsDir, false);
    await migrate(fresh, "up");
    expect(await collectionsBody(fresh)).toEqual(await collectionsBody(app));
  });
});

describe("start()", () => {
  for (const automigrate of [true, false])
    test(`automigrate ${automigrate ? "on" : "off"}`, async () => {
      const dir = tempDir();
      const app = testApp({
        migrationsDir: dir,
        automigrate,
        now: () => new Date(clock),
        argv: ["probe"],
      });
      apps.push(app);
      app.command("probe", async (_, a) => {
        await createPosts(a);
      });
      expect(await app.start()).toBe(0);
      expect(readdirSync(dir)).toEqual(
        automigrate ? ["1700000000_created_posts.ts"] : [],
      );
    });
});

describe("migration helpers", () => {
  const base = () =>
    ({
      listRule: null,
      fields: [
        { id: "a", name: "a" },
        { id: "b", name: "b" },
        { id: "c", name: "c" },
      ],
      otp: { enabled: false, duration: 180, emailTemplate: { subject: "s" } },
    }) as unknown as Collection;

  test("mergeCollection merges nested objects and replaces other values", () => {
    const c = base();
    mergeCollection(c, {
      listRule: "",
      otp: { enabled: true, emailTemplate: { body: "b" } },
      indexes: ["x"],
    });
    expect(c.listRule).toBe("");
    expect(c.otp).toEqual({
      enabled: true,
      duration: 180,
      emailTemplate: { subject: "s", body: "b" },
    });
    expect(c.indexes).toEqual(["x"]);
    mergeCollection(c, { listRule: null, otp: { emailTemplate: null } });
    expect(c.listRule).toBeNull();
    expect((c.otp as { emailTemplate: unknown }).emailTemplate).toBeNull();
  });

  test("removeFieldById removes only the matching field", () => {
    const c = base();
    removeFieldById(c, "b");
    removeFieldById(c, "missing");
    expect(c.fields.map((f) => f.id)).toEqual(["a", "c"]);
  });

  test("addFieldAt inserts, moves an existing id and clamps the index", () => {
    const c = base();
    addFieldAt(c, 1, { id: "d", name: "d" });
    expect(c.fields.map((f) => f.id)).toEqual(["a", "d", "b", "c"]);
    addFieldAt(c, 0, { id: "c", name: "renamed" });
    expect(c.fields.map((f) => f.name)).toEqual(["renamed", "a", "d", "b"]);
    addFieldAt(c, 99, { id: "a", name: "a2" });
    expect(c.fields.map((f) => f.name)).toEqual(["renamed", "d", "b", "a2"]);
  });
});
