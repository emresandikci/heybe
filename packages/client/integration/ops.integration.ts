import { afterAll, beforeAll, expect, test } from "bun:test";
import { flushLogs, waitUntil } from "../../core/contract/harness";
import { type FakeS3, startFakeS3 } from "../../core/src/files/test-s3";
import { HeybeError } from "../src/error";
import { same, startPair, type Name, type Pair } from "./pair";

let pair: Pair;
let s3: FakeS3;

const NAMES: Name[] = ["pocketbase", "heybe"];
const PASSWORD = "12345678";
const EMAIL = "ops-svc@example.com";

beforeAll(async () => {
  s3 = await startFakeS3();
  pair = await startPair();
  for (const name of NAMES)
    await pair.admin[name].records("users").create({
      email: EMAIL,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
}, 60_000);

afterAll(async () => {
  await pair?.stop();
  await s3?.stop();
});

const status = (err: HeybeError) => ({ status: err.status });

test("logs findMany, findOne, stats and truncate", async () => {
  await same(pair, async (_, t) => {
    const a = pair.admin[t.name];
    for (let i = 0; i < 3; i++)
      await fetch(`${t.url}/api/collections/missing_ops/records?__ops=${i}`);
    await flushLogs(t);
    const where = { "data.url": { like: "/api/collections/missing_ops/" } };
    const list = await waitUntil(
      () => a.logs.findMany({ where, orderBy: { created: "asc" } }),
      (l) => l.totalItems === 3,
    );
    const one = await a.logs.findOne(list.items[0]!.id);
    const noCount = await a.logs.findMany({ where, count: false });
    const stats = await a.logs.stats({ where });
    await a.logs.truncate();
    const after = await a.logs.findMany({ where });
    return {
      total: list.totalItems,
      status: list.items.map((l) => l.data.status),
      one: [one.id === list.items[0]!.id, one.data.status],
      noCount: [noCount.totalItems, noCount.totalPages],
      stats: stats.reduce((n, i) => n + i.total, 0),
      after: after.totalItems,
    };
  });
});

test("backups create, list, download, upload and delete", async () => {
  await same(pair, async (_, t) => {
    const a = pair.admin[t.name];
    await a.backups.create("ops1.zip");
    const keys = (await a.backups.list()).map((b) => b.key);
    const token = await a.files.token();
    const res = await fetch(a.backups.downloadURL(token, "ops1.zip"));
    const zip = await res.blob();
    await a.backups.upload(new File([zip], "ops2.zip"));
    const uploaded = (await a.backups.list()).map((b) => b.key).sort();
    await a.backups.delete("ops1.zip");
    await a.backups.delete("ops2.zip");
    const left = await a.backups.list();
    const missing = await a.backups
      .delete("ops1.zip")
      .catch((err: HeybeError) => status(err));
    return {
      keys,
      download: [res.status, zip.size > 0],
      uploaded,
      left,
      missing,
    };
  });
});

test("sql.run", async () => {
  await same(pair, async (_, t) => {
    const a = pair.admin[t.name];
    await a.sql.run("CREATE TABLE ops_a (id INTEGER PRIMARY KEY, name TEXT)");
    const insert = await a.sql.run("INSERT INTO ops_a (name) VALUES ('x')");
    const select = await a.sql.run("SELECT id, name FROM ops_a");
    const bad = await a.sql
      .run("SELECT * FROM nope")
      .catch((err: HeybeError) => status(err));
    return {
      affected: insert.affectedRows,
      columns: select.columns.map((c) => c.name),
      rows: select.rows,
      bad,
    };
  });
});

test("settings.testS3", async () => {
  await same(pair, async (_, t) => {
    const a = pair.admin[t.name];
    const disabled = await a.settings
      .testS3("storage")
      .catch((err: HeybeError) => err.response);
    await a.settings.update({
      s3: {
        enabled: true,
        bucket: t.name === "pocketbase" ? "pb" : "hb",
        region: "us-east-1",
        endpoint: s3.endpoint,
        accessKey: "key",
        secret: "secret",
        forcePathStyle: true,
      },
    });
    const ok = await a.settings.testS3("storage");
    await a.settings.update({ s3: { enabled: false } });
    return { disabled, ok };
  });
});

test("health as superuser reports canBackup", async () => {
  await same(pair, async (_, t) => {
    const res = await pair.admin[t.name].health.check();
    return { code: res.code, canBackup: res.data.canBackup };
  });
});

test("services reject a non-superuser", async () => {
  await same(pair, async (c) => {
    await c.auth("users").withPassword(EMAIL, PASSWORD);
    const denied = (run: () => Promise<unknown>) =>
      run().then(
        () => 200,
        (err: HeybeError) => err.status,
      );
    const statuses = [
      await denied(() => c.logs.findMany()),
      await denied(() => c.logs.findOne("x")),
      await denied(() => c.logs.stats()),
      await denied(() => c.logs.truncate()),
      await denied(() => c.backups.list()),
      await denied(() => c.backups.create()),
      await denied(() => c.backups.delete("a.zip")),
      await denied(() => c.backups.restore("a.zip")),
      await denied(() => c.sql.run("select 1")),
      await denied(() => c.settings.testS3("storage")),
    ];
    expect(statuses.every((s) => s === 403)).toBe(true);
    return statuses;
  });
});
