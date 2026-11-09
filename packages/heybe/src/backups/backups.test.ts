import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App, AppOptions } from "../app";
import { newAuthToken } from "../auth/tokens";
import * as fsModule from "node:fs";
import * as dbModule from "../db";
import { type FakeS3, startFakeS3 } from "../files/test-s3";
import { errorResponse } from "../http/errors";
import { loadAuth } from "../http/middlewares";
import { createEvent } from "../http/router";
import { createRouter } from "../http/server";
import type { MailMessage } from "../mail/mailer";
import { internalRecords } from "../records/internal";
import { testApp } from "../test-app";
import { fakeClock } from "../test-clock";
import {
  LOCAL_TEMP_DIR,
  generateBackupName,
  snakecase,
  vacuumInto,
} from "./create";
import * as zipModule from "./zip";
import { createZipWriter, extractZip } from "./zip";

const HOUR = 3_600_000;
const enc = (s: string) => new TextEncoder().encode(s);

let root: string;
let dir: string;
let clock: ReturnType<typeof fakeClock>;
let execs: [string, string[], Record<string, string | undefined>][];
let execve: NonNullable<AppOptions["execve"]>;
let app: App;
const apps: App[] = [];

const open = (opts: AppOptions = {}) => {
  const a = testApp({
    dir,
    now: clock.now,
    timers: clock.timers,
    execve: (...args) => execve(...args),
    argv: [],
    ...opts,
  });
  apps.push(a);
  return a;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "heybe-backups-"));
  dir = join(root, "data");
  clock = fakeClock("2026-01-01T00:00:00Z");
  execs = [];
  execve = (...args) => void execs.push(args);
  app = open();
  await app.bootstrap();
  await app.collections.save({
    name: "posts",
    fields: [{ name: "title", type: "text" }] as any,
  });
});

afterEach(async () => {
  for (const a of apps.splice(0)) a.close();
  await rm(root, { recursive: true, force: true });
});

const titles = (a: App) =>
  a.db
    .query<{ title: string }>("SELECT title FROM posts ORDER BY title")
    .map((r) => r.title);

// every file under dir (except the temp dir) with its size
async function listing(base = dir): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, rel: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const name = rel + e.name;
      if (name === LOCAL_TEMP_DIR) continue;
      if (e.isDirectory()) await walk(join(d, e.name), `${name}/`);
      else out.push(`${name} ${(await stat(join(d, e.name))).size}`);
    }
  };
  await walk(base, "");
  return out.sort();
}

async function unzip(name: string): Promise<string> {
  const dest = await mkdtemp(join(root, "unzip-"));
  await extractZip(join(dir, "backups", name), dest);
  return dest;
}

const entries = async (name: string) =>
  (await listing(await unzip(name))).map((l) => l.split(" ")[0]);

async function zipOf(name: string, files: Record<string, string>) {
  await mkdir(join(dir, "backups"), { recursive: true });
  const zip = await createZipWriter(join(dir, "backups", name));
  for (const [entry, path] of Object.entries(files))
    await zip.addFile(path, entry);
  await zip.close();
}

describe("names", () => {
  test.each([
    ["", ""],
    ["  ", ""],
    ["!@#$%^", ""],
    ["...", ""],
    ["_", ""],
    ["John Doe", "john_doe"],
    ["John_Doe", "john_doe"],
    [".a!b@c#d$e%123. ", "a_b_c_d_e_123"],
    ["HelloWorld", "hello_world"],
    ["HelloWorld1HelloWorld2", "hello_world1_hello_world2"],
    ["TEST", "test"],
    ["testABR", "test_abr"],
  ])("snakecase(%p) is %p", (input, expected) => {
    expect(snakecase(input)).toBe(expected);
  });

  test("default name is pb_backup_acme_20260101000000.zip", () => {
    expect(generateBackupName(app, "pb_backup_")).toBe(
      "pb_backup_acme_20260101000000.zip",
    );
  });

  test("a 60 char app name is cut to 50", async () => {
    await app.settings.update({ meta: { appName: "x".repeat(60) } });
    expect(generateBackupName(app, "@auto_pb_backup_")).toBe(
      `@auto_pb_backup_${"x".repeat(50)}_20260101000000.zip`,
    );
  });
});

describe("createBackup", () => {
  test("zip holds data.db, auxiliary.db and storage files but not backups/ or the temp dir", async () => {
    await app.files.write("pbc_1/r1/a.txt", enc("a"));
    await mkdir(join(dir, "backups"), { recursive: true });
    await Bun.write(join(dir, "backups", "old.zip"), "old");
    await Bun.write(join(dir, LOCAL_TEMP_DIR, "junk"), "junk");
    await Bun.write(join(dir, "extra.txt"), "extra");

    await app.createBackup();

    expect(await entries("pb_backup_acme_20260101000000.zip")).toEqual([
      "auxiliary.db",
      "data.db",
      "extra.txt",
      "storage/pbc_1/r1/a.txt",
    ]);
    expect(await readdir(join(dir, LOCAL_TEMP_DIR))).toEqual(["junk"]);
    expect(app.activeBackup).toBeNull();
  });

  test("onBackupCreate can rename and add excludes", async () => {
    await app.files.write("pbc_1/r1/a.txt", enc("a"));
    app.onBackupCreate((e) => {
      expect(e.name).toBe("");
      expect(e.exclude).toEqual(["backups", LOCAL_TEMP_DIR, "lost+found"]);
      e.name = "custom.zip";
      e.exclude.push("storage");
      return e.next();
    });
    await app.createBackup();
    expect(await entries("custom.zip")).toEqual(["auxiliary.db", "data.db"]);
  });

  test("a handler without next() creates nothing", async () => {
    app.onBackupCreate(() => {});
    await app.createBackup("x.zip");
    expect(existsSync(join(dir, "backups", "x.zip"))).toBe(false);
  });

  test("a second create while one runs fails with PB's message", async () => {
    const first = app.createBackup("one.zip");
    expect(app.activeBackup).toBe("one.zip");
    const busy =
      "try again later - another backup/restore operation has already been started";
    await expect(app.createBackup("two.zip")).rejects.toThrow(busy);
    await expect(app.restoreBackup("one.zip")).rejects.toThrow(busy);
    await first;
    expect(await readdir(join(dir, "backups"))).toEqual(["one.zip"]);
  });

  test("files and records changed during the run follow the data.db snapshot", async () => {
    await app.records("posts").create({ title: "before" });
    await app.files.write("pbc_1/r1/old.txt", enc("old"));
    await app.files.write("pbc_1/r1/a.txt", enc("a"));
    await app.files.write("pbc_1/r1/z.txt", enc("z"));
    // z.txt is deleted while the storage walk zips a.txt
    const createWriter = zipModule.createZipWriter;
    let walked = false;
    const zipSpy = spyOn(zipModule, "createZipWriter").mockImplementation(
      async (path) => {
        const w = await createWriter(path);
        return {
          async addFile(local, name) {
            if (name === "storage/pbc_1/r1/a.txt" && !walked) {
              walked = true;
              await app.files.delete("pbc_1/r1/z.txt");
            }
            return w.addFile(local, name);
          },
          close: () => w.close(),
        };
      },
    );
    const original = dbModule.exclusive;
    let done = false;
    const spy = spyOn(dbModule, "exclusive").mockImplementation((async (
      db: dbModule.Db,
      fn: () => unknown,
    ) => {
      const result = await original(db, fn);
      if (db === app.db && !done) {
        done = true;
        await app.files.delete("pbc_1/r1/old.txt");
        await app.files.write("pbc_1/r1/new.txt", enc("new"));
        await app.records("posts").create({ title: "during" });
      }
      return result;
    }) as typeof original);
    try {
      await app.createBackup("c.zip");
    } finally {
      spy.mockRestore();
      zipSpy.mockRestore();
    }
    expect(done).toBe(true);
    expect(walked).toBe(true);
    expect(await entries("c.zip")).toEqual([
      "auxiliary.db",
      "data.db",
      "storage/pbc_1/r1/a.txt",
      "storage/pbc_1/r1/old.txt",
      "storage/pbc_1/r1/z.txt",
    ]);
    const out = await unzip("c.zip");
    expect(await Bun.file(join(out, "storage/pbc_1/r1/old.txt")).text()).toBe(
      "old",
    );
    expect(existsSync(join(out, "storage/pbc_1/r1/new.txt"))).toBe(false);
    const db = new Database(join(out, "data.db"));
    expect(
      db
        .query("SELECT title FROM posts")
        .all()
        .map((r: any) => r.title),
    ).toEqual(["before"]);
    db.close();
  });
  test("a file zipped by the walk and deleted later in the run is zipped once", async () => {
    await app.files.write("pbc_1/r1/a.txt", enc("a"));
    await app.files.write("pbc_1/r1/b.txt", enc("b"));
    const createWriter = zipModule.createZipWriter;
    const added: string[] = [];
    const zipSpy = spyOn(zipModule, "createZipWriter").mockImplementation(
      async (path) => {
        const w = await createWriter(path);
        return {
          async addFile(local, name) {
            added.push(name);
            if (name === "storage/pbc_1/r1/b.txt")
              await app.files.delete("pbc_1/r1/a.txt");
            return w.addFile(local, name);
          },
          close: () => w.close(),
        };
      },
    );
    try {
      await app.createBackup("d.zip");
    } finally {
      zipSpy.mockRestore();
    }
    expect(added.filter((n) => n === "storage/pbc_1/r1/a.txt")).toHaveLength(1);
    expect(await entries("d.zip")).toContain("storage/pbc_1/r1/a.txt");
  });

  test("VACUUM INTO runs off the main thread", async () => {
    // a rollback-journal db locked by an open write: the vacuum can only finish after the commit below
    const path = join(root, "locked.db");
    const lock = new Database(path);
    lock.run("CREATE TABLE t (v TEXT)");
    lock.run("BEGIN EXCLUSIVE");
    lock.run("INSERT INTO t VALUES ('late')");
    let finished = false;
    const vacuum = vacuumInto(path, join(root, "copy.db"), 10_000).then(() => {
      finished = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(finished).toBe(false);
    lock.run("COMMIT");
    lock.close();
    await vacuum;
    const copy = new Database(join(root, "copy.db"));
    expect(copy.query("SELECT v FROM t").all()).toEqual([{ v: "late" }]);
    copy.close();
  });
});

describe("restoreBackup", () => {
  test("restores the data dir and re-executes the process", async () => {
    await app.records("posts").create({ title: "a" });
    await app.files.write("pbc_1/r1/a.txt", enc("a"));
    await app.createBackup("b1.zip");
    await app.records("posts").create({ title: "b" });
    await app.files.write("pbc_1/r2/b.txt", enc("b"));
    await app.settings.update({ meta: { appName: "Changed" } });

    await app.restoreBackup("b1.zip");

    expect(execs).toEqual([[process.execPath, process.argv, process.env]]);
    expect(app.activeBackup).toBeNull();
    app.close();
    const restored = open();
    expect(existsSync(join(dir, LOCAL_TEMP_DIR))).toBe(true);
    await restored.bootstrap();
    expect(existsSync(join(dir, LOCAL_TEMP_DIR))).toBe(false);
    expect(titles(restored)).toEqual(["a"]);
    expect(restored.settings.current().meta.appName).toBe("Acme");
    expect(await restored.files.exists("pbc_1/r1/a.txt")).toBe(true);
    expect(await restored.files.exists("pbc_1/r2/b.txt")).toBe(false);
    expect(await readdir(join(dir, "backups"))).toEqual(["b1.zip"]);
  });

  describe("an invalid backup leaves the data dir untouched", () => {
    const cases: [string, () => Promise<string>, string][] = [
      [
        "a missing name",
        async () => "nope.zip",
        'missing or invalid backup file "nope.zip" to restore',
      ],
      [
        "a zip without data.db",
        async () => {
          const f = join(root, "x.txt");
          await Bun.write(f, "x");
          await zipOf("no-db.zip", { "storage/x.txt": f });
          return "no-db.zip";
        },
        "data.db file is missing or invalid: ",
      ],
      [
        "a PocketBase data.db",
        async () => {
          const f = join(root, "data.db");
          const db = new Database(f);
          db.run("CREATE TABLE _collections (id TEXT, fields JSON)");
          db.close();
          await zipOf("pb.zip", { "data.db": f });
          return "pb.zip";
        },
        "data.db file is missing or invalid: not a Heybe backup",
      ],
      [
        "a zip-slip entry",
        async () => {
          const f = join(root, "x.txt");
          await Bun.write(f, "x");
          await zipOf("slip.zip", { "../evil.txt": f });
          return "slip.zip";
        },
        "invalid file path: ",
      ],
      [
        "a truncated zip",
        async () => {
          await app.createBackup("full.zip");
          const bytes = await Bun.file(join(dir, "backups/full.zip")).bytes();
          await Bun.write(
            join(dir, "backups/trunc.zip"),
            bytes.slice(0, bytes.length >> 1),
          );
          return "trunc.zip";
        },
        "",
      ],
    ];
    test.each(cases)("%s", async (_, prepare, message) => {
      await app.records("posts").create({ title: "keep" });
      await app.files.write("pbc_1/r1/a.txt", enc("a"));
      const name = await prepare();
      const before = await listing();

      await expect(app.restoreBackup(name)).rejects.toThrow(message);

      expect(await listing()).toEqual(before);
      expect(existsSync(join(dir, "evil.txt"))).toBe(false);
      expect(existsSync(join(dir, LOCAL_TEMP_DIR, "evil.txt"))).toBe(false);
      expect(execs).toEqual([]);
      expect(app.activeBackup).toBeNull();
    });
  });

  test("execve throwing reverts the data dir and the app keeps serving", async () => {
    await app.records("posts").create({ title: "a" });
    await app.createBackup("b1.zip");
    await app.records("posts").create({ title: "b" });
    await app.files.write("pbc_1/r2/b.txt", enc("b"));
    const before = await listing();
    execve = () => {
      throw new Error("boom");
    };

    await expect(app.restoreBackup("b1.zip")).rejects.toThrow(
      "failed to restart the app process: boom",
    );

    expect(await listing()).toEqual(before);
    await app.records("posts").create({ title: "c" });
    expect(titles(app)).toEqual(["a", "b", "c"]);
    expect(await app.files.exists("pbc_1/r2/b.txt")).toBe(true);
    expect(app.activeBackup).toBeNull();
  });

  test("a failed move puts the data dir back and the app keeps serving", async () => {
    await app.records("posts").create({ title: "a" });
    await app.files.write("pbc_1/r1/a.txt", enc("a"));
    await app.createBackup("b1.zip");
    await app.records("posts").create({ title: "b" });
    const before = await listing();
    const rename = fsModule.renameSync;
    // the extracted storage dir moves in after its data.db
    const spy = spyOn(fsModule, "renameSync").mockImplementation((from, to) => {
      if (
        String(from).includes("pb_restore_") &&
        String(from).endsWith("storage")
      )
        throw new Error("EXDEV");
      return rename(from, to);
    });
    try {
      await expect(app.restoreBackup("b1.zip")).rejects.toThrow(
        "failed to move the extracted archive content to pb_data: EXDEV",
      );
    } finally {
      spy.mockRestore();
    }
    expect(await listing()).toEqual(before);
    await app.records("posts").create({ title: "c" });
    expect(titles(app)).toEqual(["a", "b", "c"]);
    expect(execs).toEqual([]);
  });

  test("onBackupRestore without next() does nothing", async () => {
    await app.createBackup("b1.zip");
    const before = await listing();
    let seen: unknown;
    app.onBackupRestore((e) => {
      seen = [e.name, e.exclude];
    });
    await app.restoreBackup("b1.zip");
    expect(seen).toEqual(["b1.zip", ["backups", LOCAL_TEMP_DIR, "lost+found"]]);
    expect(execs).toEqual([]);
    expect(await listing()).toEqual(before);
  });
});

describe("restart", () => {
  test("triggers onTerminate with isRestart and keeps the db open", async () => {
    let restart: boolean | undefined;
    app.onTerminate((e) => {
      restart = e.isRestart;
      return e.next();
    });
    await app.restart();
    expect(restart).toBe(true);
    expect(execs).toHaveLength(1);
    expect(titles(app)).toEqual([]);
  });
});

describe("auto backups", () => {
  const job = (a = app) =>
    a.scheduler.jobs().find((j) => j.id === "__pbAutoBackup__");

  test("keeps the newest cronMaxKeep auto backups", async () => {
    await mkdir(join(dir, "backups"), { recursive: true });
    await Bun.write(join(dir, "backups", "manual.zip"), "m");
    await app.settings.update({
      backups: { cron: "0 * * * *", cronMaxKeep: 2 },
    });
    expect(job()?.expression).toBe("0 * * * *");
    for (let i = 0; i < 3; i++) {
      clock.advance(HOUR);
      await job()!.run();
    }
    expect((await readdir(join(dir, "backups"))).sort()).toEqual([
      "@auto_pb_backup_acme_20260101020000.zip",
      "@auto_pb_backup_acme_20260101030000.zip",
      "manual.zip",
    ]);
  });

  test("an empty cron removes the job, bootstrap loads it", async () => {
    await app.settings.update({
      backups: { cron: "0 * * * *", cronMaxKeep: 1 },
    });
    expect(job()).toBeDefined();
    await app.settings.update({ backups: { cron: "" } });
    expect(job()).toBeUndefined();

    await app.settings.update({
      backups: { cron: "*/5 * * * *", cronMaxKeep: 1 },
    });
    app.close();
    const next = open();
    expect(job(next)).toBeUndefined();
    await next.bootstrap();
    expect(job(next)?.expression).toBe("*/5 * * * *");
  });

  test("a failing create logs the error and alerts every superuser", async () => {
    const s3 = await startFakeS3();
    try {
      const superusers = internalRecords(app, "_superusers");
      for (const email of ["a@example.com", "b@example.com"])
        await superusers.create({ email, password: "1234567890" });
      const sent: MailMessage[] = [];
      app.mailer = { send: async (m) => void sent.push(m) };
      await app.settings.update({
        meta: { appName: "Acme <x>" },
        backups: {
          cron: "0 * * * *",
          cronMaxKeep: 5,
          s3: {
            enabled: true,
            bucket: "hb",
            region: "us-east-1",
            endpoint: s3.endpoint,
            accessKey: "key",
            secret: "secret",
            forcePathStyle: true,
          },
        },
      });
      await s3.stop();

      await job()!.run();
      await app.logger.flush();

      const rows = app.auxDb.query<{ level: number; data: string }>(
        "SELECT level, data FROM _logs WHERE message = '[Backup cron] Failed to create backup'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.level).toBe(8);
      const data = JSON.parse(rows[0]!.data);
      expect(data.name).toBe("@auto_pb_backup_acme_x_20260101000000.zip");
      expect(typeof data.error).toBe("string");
      expect(sent.map((m) => m.to.map((t) => t.address))).toEqual([
        ["a@example.com"],
        ["b@example.com"],
      ]);
      expect(sent[0]!.subject).toBe(
        "[Acme <x> system alert] Autobackup failure",
      );
      expect(sent[0]!.html).toContain(
        "<p>Acme &lt;x&gt; system alert occurred:</p>",
      );
      expect(sent[0]!.html).toContain(
        `<p class="alert"><strong>Failed to create/upload automated backup. Raw error:\n${data.error
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&#34;")
          .replaceAll("'", "&#39;")}</strong></p>`,
      );
      expect(s3.objects("hb").size).toBe(0);
    } finally {
      await s3.stop();
    }
  });
});

describe("S3 backups", () => {
  let s3: FakeS3;

  beforeEach(async () => {
    s3 = await startFakeS3();
    await app.settings.update({
      backups: {
        s3: {
          enabled: true,
          bucket: "hb",
          region: "us-east-1",
          endpoint: s3.endpoint,
          accessKey: "key",
          secret: "secret",
          forcePathStyle: true,
        },
      },
    });
  });

  afterEach(() => s3.stop());

  test("create, list and restore through S3", async () => {
    await app.records("posts").create({ title: "a" });
    await app.createBackup("s3.zip");
    expect(s3.objects("hb").get("s3.zip")?.type).toBe("application/zip");
    expect(
      (await app.newBackupsFilesystem().list("")).map((f) => f.key),
    ).toEqual(["s3.zip"]);
    expect(existsSync(join(dir, "backups", "s3.zip"))).toBe(false);
    await app.records("posts").create({ title: "b" });

    await app.restoreBackup("s3.zip");

    expect(execs).toHaveLength(1);
    app.close();
    const restored = open();
    await restored.bootstrap();
    expect(titles(restored)).toEqual(["a"]);
  });
});

describe("health", () => {
  async function superToken(): Promise<string> {
    const records = internalRecords(app, "_superusers");
    const su = await records.create({
      email: "su@example.com",
      password: "1234567890",
    });
    return newAuthToken(
      app,
      app.collections.find("_superusers")!,
      records.findRaw(su.id as string),
    );
  }

  async function health(
    token: string | null,
    headers: Record<string, string> = {},
  ): Promise<any> {
    const req = new Request("http://x/api/health", {
      headers: token ? { ...headers, authorization: token } : headers,
    });
    const found = createRouter().build().match("GET", "/api/health")!;
    const e = createEvent(app, req, found.params, "1.2.3.4", found.pattern);
    e.auth = loadAuth(app, req);
    try {
      return await (await found.run(e)).json();
    } catch (err) {
      return await errorResponse(err).json();
    }
  }

  test("a guest gets empty data", async () => {
    expect(await health(null, { "X-Forwarded-For": "5.5.5.5" })).toEqual({
      message: "API is healthy.",
      code: 200,
      data: {},
    });
  });

  test("a superuser gets canBackup, realIP and possibleProxyHeader", async () => {
    const token = await superToken();
    expect((await health(token)).data).toEqual({
      canBackup: true,
      realIP: "1.2.3.4",
      possibleProxyHeader: "",
    });
    expect(
      (
        await health(token, {
          "X-Forwarded-For": "5.5.5.5",
          "Fly-Client-IP": "6.6.6.6",
        })
      ).data.possibleProxyHeader,
    ).toBe("Fly-Client-IP");
    await app.settings.update({
      trustedProxy: { headers: ["X-Real-IP"], useLeftmostIP: false },
    });
    expect(
      (
        await health(token, {
          "X-Forwarded-For": "5.5.5.5",
          "X-Real-IP": "7.7.7.7",
        })
      ).data,
    ).toEqual({
      canBackup: true,
      realIP: "7.7.7.7",
      possibleProxyHeader: "X-Real-IP",
    });
  });

  test("canBackup is false while a backup runs", async () => {
    const token = await superToken();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    app.onBackupCreate(async (e) => {
      await gate;
      return e.next();
    });
    const running = app.createBackup();
    expect((await health(token)).data.canBackup).toBe(false);
    release();
    await running;
    expect((await health(token)).data.canBackup).toBe(true);
  });
});
