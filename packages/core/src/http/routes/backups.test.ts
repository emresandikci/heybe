import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App, AppOptions } from "../../app";
import { newAuthToken, newFileToken } from "../../auth/tokens";
import { createZipWriter } from "../../backups/zip";
import { internalRecords } from "../../records/internal";
import { testApp } from "../../test-app";
import { fakeClock } from "../../test-clock";
import { errorResponse } from "../errors";
import { loadAuth } from "../middlewares";
import { createEvent } from "../router";
import { createRouter } from "../server";

let root: string;
let clock: ReturnType<typeof fakeClock>;
let execs: unknown[][];
let execve: NonNullable<AppOptions["execve"]>;
let app: App;
let superToken: string;
let userToken: string;
let seq = 0;

const VALIDATION = "An error occurred while validating the submitted data.";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "heybe-backups-api-"));
  clock = fakeClock("2026-01-01T00:00:00Z");
  execs = [];
  execve = (...args) => void execs.push(args);
  app = testApp({
    dir: join(root, "data"),
    now: clock.now,
    timers: clock.timers,
    execve: (...args) => execve(...args),
    argv: [],
  });
  await app.bootstrap();
  superToken = await authToken("_superusers");
  userToken = await authToken("users");
});

afterEach(async () => {
  app.close();
  await rm(root, { recursive: true, force: true });
});

async function createAuth(collection: string) {
  const records = internalRecords(app, collection);
  const created = await records.create({
    email: `bk${seq++}@example.com`,
    password: "1234567890",
  });
  return {
    collection: app.collections.find(collection)!,
    record: records.findRaw(created.id as string),
  };
}

async function authToken(collection: string) {
  const { collection: c, record } = await createAuth(collection);
  return newAuthToken(app, c, record);
}

async function fileToken(collection: string) {
  const { collection: c, record } = await createAuth(collection);
  return newFileToken(app, c, record);
}

async function call(
  method: string,
  path: string,
  opts: {
    token?: string | null;
    body?: unknown;
    headers?: Record<string, string>;
    ip?: string;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  const token = opts.token === undefined ? superToken : opts.token;
  if (token) headers.authorization = token;
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) body = opts.body;
  else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const req = new Request(`http://x${path}`, { method, headers, body });
  const url = new URL(req.url);
  const found = createRouter().build().match(method, url.pathname)!;
  const e = createEvent(
    app,
    req,
    found.params,
    opts.ip ?? "1.2.3.4",
    found.pattern,
  );
  e.auth = loadAuth(app, req);
  try {
    return await found.run(e);
  } catch (err) {
    return errorResponse(err);
  }
}

async function expectError(res: Response, status: number, message: string) {
  const body = await res.json();
  expect([res.status, body.message]).toEqual([status, message]);
  return body.data;
}

async function zipBytes(): Promise<Uint8Array<ArrayBuffer>> {
  const src = join(root, "entry.txt");
  await writeFile(src, "hello");
  const path = join(root, `z${seq++}.zip`);
  const zip = await createZipWriter(path);
  await zip.addFile(src, "entry.txt");
  await zip.close();
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

const uploadForm = (data: Uint8Array<ArrayBuffer> | string, name: string) => {
  const form = new FormData();
  form.append("file", new File([data], name));
  return form;
};

const backupKeys = async () =>
  (await app.newBackupsFilesystem().list("")).map((f) => f.key);

describe("auth", () => {
  test("guests get 401 and users 403 on the superuser routes", async () => {
    const routes: [string, string][] = [
      ["GET", "/api/backups"],
      ["POST", "/api/backups"],
      ["POST", "/api/backups/upload"],
      ["DELETE", "/api/backups/a.zip"],
      ["POST", "/api/backups/a.zip/restore"],
    ];
    for (const [method, path] of routes) {
      expect((await call(method, path, { token: null })).status).toBe(401);
      expect((await call(method, path, { token: userToken })).status).toBe(403);
    }
  });
});

describe("GET /api/backups", () => {
  test("lists key, size and modified in key order", async () => {
    await app.createBackup("b.zip");
    await app.createBackup("a.zip");
    const res = await call("GET", "/api/backups");
    expect(res.status).toBe(200);
    const items = (await res.json()) as any[];
    expect(items.map((i) => i.key)).toEqual(["a.zip", "b.zip"]);
    for (const item of items) {
      expect(item.size).toBeGreaterThan(0);
      expect(item.modified).toMatch(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    }
  });

  test("a list failure is a 400 with the raw error", async () => {
    const fs = app.newBackupsFilesystem();
    spyOn(app, "newBackupsFilesystem").mockReturnValue({
      ...fs,
      list: () => Promise.reject(new Error("boom")),
    });
    await expectError(
      await call("GET", "/api/backups"),
      400,
      "Failed to retrieve backup items. Raw error: \nboom.",
    );
  });
});

describe("POST /api/backups", () => {
  test("creates a named backup", async () => {
    const res = await call("POST", "/api/backups", { body: { name: "x.zip" } });
    expect(res.status).toBe(204);
    expect(await backupKeys()).toEqual(["x.zip"]);
  });

  test("without a body the name is generated", async () => {
    expect((await call("POST", "/api/backups")).status).toBe(204);
    expect(await backupKeys()).toEqual(["hb_backup_acme_20260101000000.zip"]);
  });

  test("name validation", async () => {
    await app.createBackup("x.zip");
    const cases: [unknown, unknown][] = [
      [
        "x.zip",
        {
          code: "validation_backup_name_exists",
          message: "The backup file name is invalid or already exists.",
        },
      ],
      [
        "Bad.zip",
        {
          code: "validation_match_invalid",
          message: "Must be in a valid format.",
        },
      ],
      [
        `${"a".repeat(147)}.zip`,
        {
          code: "validation_length_out_of_range",
          message: "The length must be between 1 and 150.",
          params: { min: 1, max: 150 },
        },
      ],
    ];
    for (const [name, error] of cases) {
      const data = await expectError(
        await call("POST", "/api/backups", { body: { name } }),
        400,
        VALIDATION,
      );
      expect(data).toEqual({ name: error });
    }
  });

  test("a non-string name fails to load", async () => {
    await expectError(
      await call("POST", "/api/backups", { body: { name: 1 } }),
      400,
      "An error occurred while loading the submitted data.",
    );
  });

  test("a running backup blocks a new one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    app.onBackupCreate(async (e) => {
      await gate;
      return e.next();
    });
    const running = app.createBackup("first.zip");
    await expectError(
      await call("POST", "/api/backups", { body: { name: "x.zip" } }),
      400,
      // PB sentenizes the message
      "Try again later - another backup/restore process has already been started.",
    );
    release();
    await running;
  });

  test("a create failure is a 400", async () => {
    app.onBackupCreate(() => {
      throw new Error("nope");
    });
    await expectError(
      await call("POST", "/api/backups", { body: { name: "x.zip" } }),
      400,
      "Failed to create backup.",
    );
  });
});

describe("POST /api/backups/upload", () => {
  test("stores the zip under its base name", async () => {
    const form = uploadForm(await zipBytes(), "a/../../evil.zip");
    const res = await call("POST", "/api/backups/upload", { body: form });
    expect(res.status).toBe(204);
    expect(await backupKeys()).toEqual(["evil.zip"]);
    expect(existsSync(join(root, "evil.zip"))).toBe(false);
  });

  test("a missing file is required", async () => {
    const data = await expectError(
      await call("POST", "/api/backups/upload", { body: new FormData() }),
      400,
      VALIDATION,
    );
    expect(data).toEqual({
      file: { code: "validation_required", message: "Cannot be blank." },
    });
  });

  test("a text file fails the mime check", async () => {
    const res = await call("POST", "/api/backups/upload", {
      body: uploadForm("hello", "test.zip"),
    });
    const data = await expectError(res, 400, VALIDATION);
    expect(data.file.code).toBe("validation_invalid_mime_type");
    expect(data.file.message).toMatch(
      /^"test_[a-z0-9]{10}\.zip" mime type must be one of: application\/zip\.$/,
    );
    expect(await backupKeys()).toEqual([]);
  });

  test("a duplicate name fails", async () => {
    await app.createBackup("dup.zip");
    const data = await expectError(
      await call("POST", "/api/backups/upload", {
        body: uploadForm(await zipBytes(), "dup.zip"),
      }),
      400,
      VALIDATION,
    );
    expect(data).toEqual({
      file: {
        code: "validation_backup_name_exists",
        message: "Backup file with the specified name already exists.",
      },
    });
  });

  test("a store failure is a 400", async () => {
    const fs = app.newBackupsFilesystem();
    spyOn(app, "newBackupsFilesystem").mockReturnValue({
      ...fs,
      write: () => Promise.reject(new Error("full")),
    });
    await expectError(
      await call("POST", "/api/backups/upload", {
        body: uploadForm(await zipBytes(), "x.zip"),
      }),
      400,
      "Failed to upload backup.",
    );
  });
});

describe("GET /api/backups/{key}", () => {
  const FORBIDDEN = "Insufficient permissions to access the resource.";

  beforeEach(() => app.createBackup("dl.zip"));

  test("a superuser file token downloads the zip", async () => {
    const token = await fileToken("_superusers");
    const res = await call("GET", `/api/backups/dl.zip?token=${token}`, {
      token: null,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="dl.zip"',
    );
    const bytes = await res.arrayBuffer();
    expect(bytes.byteLength).toBe(
      await Bun.file(join(root, "data/backups/dl.zip")).size,
    );
  });

  test("a range request answers 206", async () => {
    const token = await fileToken("_superusers");
    const res = await call("GET", `/api/backups/dl.zip?token=${token}`, {
      token: null,
      headers: { range: "bytes=0-3" },
    });
    expect(res.status).toBe(206);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    );
  });

  test("a user file token, no token and an auth token are forbidden", async () => {
    for (const token of [await fileToken("users"), "", superToken]) {
      await expectError(
        await call("GET", `/api/backups/dl.zip?token=${token}`, {
          token: null,
        }),
        403,
        FORBIDDEN,
      );
    }
  });

  test("a superuser IP outside the allowed list is forbidden", async () => {
    const token = await fileToken("_superusers");
    await app.settings.update({ superuserIPs: ["9.9.9.9"] });
    await expectError(
      await call("GET", `/api/backups/dl.zip?token=${token}`, { token: null }),
      403,
      FORBIDDEN,
    );
    const res = await call("GET", `/api/backups/dl.zip?token=${token}`, {
      token: null,
      ip: "9.9.9.9",
    });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/backups/{key}", () => {
  test("deletes the backup", async () => {
    await app.createBackup("del.zip");
    expect((await call("DELETE", "/api/backups/del.zip")).status).toBe(204);
    expect(await backupKeys()).toEqual([]);
  });

  test("a missing backup is a 400 with the raw error", async () => {
    const res = await call("DELETE", "/api/backups/missing.zip");
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.message).toStartWith(
      "Invalid or already deleted backup file. Raw error: \n",
    );
  });

  test("the active backup cannot be deleted", async () => {
    await app.createBackup("busy.zip");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    app.onBackupCreate(async (e) => {
      await gate;
      return e.next();
    });
    const running = app.createBackup("busy.zip");
    await expectError(
      await call("DELETE", "/api/backups/busy.zip"),
      400,
      "The backup is currently being used and cannot be deleted.",
    );
    release();
    await running;
  });
});

describe("POST /api/backups/{key}/restore", () => {
  test("answers 204 and restores after 1000 ms", async () => {
    await app.createBackup("rs.zip");
    let restarted!: () => void;
    const done = new Promise<void>((r) => (restarted = r));
    execve = (...args) => {
      execs.push(args);
      restarted();
    };
    expect((await call("POST", "/api/backups/rs.zip/restore")).status).toBe(
      204,
    );
    clock.advance(999);
    expect(execs).toHaveLength(0);
    expect(app.activeBackup).toBeNull();
    clock.advance(1);
    await done;
    expect(execs).toHaveLength(1);
  });

  test("a missing backup is a 400", async () => {
    const restore = spyOn(app, "restoreBackup");
    await expectError(
      await call("POST", "/api/backups/missing.zip/restore"),
      400,
      "Missing or invalid backup file.",
    );
    clock.advance(1000);
    expect(restore).not.toHaveBeenCalled();
  });

  test("a file that is not a Heybe backup is a 400", async () => {
    await Bun.write(join(app.dataDir, "backups", "pb.zip"), await zipBytes());
    const restore = spyOn(app, "restoreBackup");
    await expectError(
      await call("POST", "/api/backups/pb.zip/restore"),
      400,
      "The file is not a Heybe backup.",
    );
    clock.advance(1000);
    expect(restore).not.toHaveBeenCalled();
  });

  test("a running backup blocks the restore", async () => {
    await app.createBackup("rs.zip");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    app.onBackupCreate(async (e) => {
      await gate;
      return e.next();
    });
    const running = app.createBackup("other.zip");
    await expectError(
      await call("POST", "/api/backups/rs.zip/restore"),
      400,
      "Try again later - another backup/restore process has already been started.",
    );
    release();
    await running;
  });

  test("a restore failure is logged", async () => {
    await app.createBackup("rs.zip");
    app.onBackupRestore(() => {
      throw new Error("broken");
    });
    let logged!: (args: unknown[]) => void;
    const log = new Promise<unknown[]>((r) => (logged = r));
    spyOn(app.logger, "error").mockImplementation((...args) => logged(args));
    expect((await call("POST", "/api/backups/rs.zip/restore")).status).toBe(
      204,
    );
    clock.advance(1000);
    expect(await log).toEqual([
      "Failed to restore backup",
      { key: "rs.zip", error: "broken" },
    ]);
  });
});
