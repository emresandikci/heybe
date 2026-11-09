import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, createApp } from "../app";
import { fakeClock } from "../test-clock";
import { testApp } from "../test-app";
import { openAuxDb } from "./aux-db";

const tick = () => new Promise((resolve) => setImmediate(resolve));

interface Row {
  id: string;
  level: number;
  message: string;
  data: string;
  created: string;
}

describe("app logger", () => {
  let clock: ReturnType<typeof fakeClock>;
  let app: App;

  beforeEach(() => {
    clock = fakeClock("2026-01-10T12:00:00Z");
    app = testApp({ now: clock.now, timers: clock.timers });
  });
  afterEach(() => app.close());

  const rows = () => app.auxDb.query<Row>("SELECT * FROM _logs ORDER BY rowid");
  const insert = (level: number, created: string) =>
    app.auxDb.write(() =>
      app.auxDb.run(
        "INSERT INTO _logs (id, level, message, data, created) VALUES (?, ?, '', '{}', ?)",
        [crypto.randomUUID(), level, created],
      ),
    );

  test("aux schema has PB's columns and indexes", () => {
    expect(
      app.auxDb
        .query<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: string;
          pk: number;
        }>("PRAGMA table_info(_logs)")
        .map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]),
    ).toEqual([
      ["id", "TEXT", 1, "'r'||lower(hex(randomblob(7)))", 1],
      ["level", "INTEGER", 1, "0", 0],
      ["message", "TEXT", 1, '""', 0],
      ["data", "JSON", 1, '"{}"', 0],
      ["created", "TEXT", 1, "strftime('%Y-%m-%d %H:%M:%fZ')", 0],
    ]);
    expect(
      app.auxDb
        .query<{ name: string }>("PRAGMA index_list(_logs)")
        .map((i) => i.name)
        .sort(),
    ).toEqual([
      "idx_logs_created_hour",
      "idx_logs_level",
      "idx_logs_message",
      "sqlite_autoindex__logs_1",
    ]);
  });

  test("the 200th entry writes the whole batch at once", async () => {
    for (let i = 0; i < 199; i++) app.logger.info(`m${i}`);
    await tick();
    expect(rows()).toHaveLength(0);
    app.logger.warn("last", { n: 1 });
    await tick();
    const all = rows();
    expect(all).toHaveLength(200);
    expect(all[199]).toMatchObject({
      level: 4,
      message: "last",
      data: '{"n":1}',
      created: "2026-01-10 12:00:00.000Z",
    });
    expect(all[0]!.id).toHaveLength(15);
    expect(clock.pending()).toBe(0);
  });

  test("entries are written 3000 ms after the last one and each entry pushes the timer back", async () => {
    app.logger.info("a");
    clock.advance(2000);
    app.logger.debug("b");
    app.logger.error("c");
    clock.advance(2999);
    await tick();
    expect(rows()).toHaveLength(0);
    clock.advance(1);
    await tick();
    expect(rows().map((r) => [r.message, r.level, r.created])).toEqual([
      ["a", 0, "2026-01-10 12:00:00.000Z"],
      ["c", 8, "2026-01-10 12:00:02.000Z"],
    ]);
  });

  test("maxDays 0 queues nothing", async () => {
    await app.settings.update({ logs: { maxDays: 0 } });
    app.logger.error("x");
    expect(clock.pending()).toBe(0);
    await app.logger.flush();
    expect(rows()).toHaveLength(0);
  });

  test("minLevel drops lower levels outside dev", async () => {
    await app.settings.update({ logs: { minLevel: 4 } });
    const out = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      app.logger.info("info");
      app.logger.warn("warn");
      app.logger.log(6, "custom");
      await app.logger.flush();
      expect(out).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
    }
    expect(rows().map((r) => r.message)).toEqual(["warn", "custom"]);
  });

  test("dev prints every entry and stores only those >= minLevel", async () => {
    app.dev = true;
    const printed: string[] = [];
    const out = spyOn(process.stdout, "write").mockImplementation((s) => {
      printed.push(String(s).replace(/\x1b\[[\d;]*m/g, ""));
      return true;
    });
    try {
      app.logger.debug("d");
      app.logger.info("i", { a: 1 });
      app.logger.warn("w", { err: new Error("boom") });
      app.logger.error("GET /x", {
        type: "request",
        error: "Not found.",
        details: { id: "x" },
        url: "/x",
      });
      app.logger.log(2, "c");
    } finally {
      out.mockRestore();
    }
    expect(printed.join("")).toBe(
      [
        "DEBUG d",
        "INFO i",
        '└─ {"a":1}',
        "WARN w",
        '└─ {"err":"boom"}',
        "ERROR GET /x",
        "└─ Not found.",
        '   └─ {"id":"x"}',
        "[2] c",
        "",
      ].join("\n"),
    );
    await app.logger.flush();
    expect(rows().map((r) => r.message)).toEqual(["i", "w", "GET /x", "c"]);
  });

  test("message cut to 8000 bytes", async () => {
    app.logger.info("x".repeat(7999) + "é" + "tail");
    await app.logger.flush();
    expect(rows()[0]!.message).toBe("x".repeat(7999));
    app.logger.info("y".repeat(9000));
    await app.logger.flush();
    expect(rows()[1]!.message).toBe("y".repeat(8000));
  });

  test("data over maxDataSize keeps leading keys and adds __pb_truncated__", async () => {
    await app.settings.update({ logs: { maxDataSize: 29 } });
    // {"a":"1234","b":"5678","c":"9"} is 31 bytes, "b" ends at byte 22 and "c" at 30
    app.logger.info("t", { a: "1234", b: "5678", c: "9" });
    app.logger.info("fits", { a: "1" });
    await app.logger.flush();
    expect(rows().map((r) => r.data)).toEqual([
      '{"a":"1234","b":"5678","__pb_truncated__":true}',
      '{"a":"1"}',
    ]);
  });

  test("the default maxDataSize is 16384", async () => {
    app.logger.info("big", { a: "x".repeat(100_000), b: 1 });
    await app.logger.flush();
    expect(rows()[0]!.data).toBe('{"__pb_truncated__":true}');
  });

  test("bigint, Error and cyclic data do not throw", async () => {
    const cycle: Record<string, unknown> = { a: 1 };
    cycle.self = cycle;
    app.logger.info("mixed", {
      big: 10n ** 20n,
      error: new Error("boom"),
      nested: { error: new TypeError("inner") },
    });
    app.logger.info("cycle", { cycle });
    app.logger.info("text", { text: "z".repeat(100_000) });
    await app.logger.flush();
    expect(rows().map((r) => r.data)).toEqual([
      '{"big":"100000000000000000000","error":"boom","nested":{"error":"inner"}}',
      "{}",
      '{"__pb_truncated__":true}',
    ]);
  });

  test("a closed aux db does not throw from log or flush", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      app.auxDb.close();
      app.logger.warn("lost");
      await app.logger.flush();
      for (let i = 0; i < 200; i++) app.logger.info("batch");
      await tick();
      expect(err.mock.calls.map((c) => c[0])).toEqual([
        "Failed to write log",
        "Failed to write log",
      ]);
    } finally {
      err.mockRestore();
    }
  });

  test("a batch queued before logs are disabled is dropped", async () => {
    app.logger.warn("queued");
    await app.settings.update({ logs: { maxDays: 0 } });
    await app.logger.flush();
    expect(rows()).toHaveLength(0);
  });

  test("a locked aux db fails the batch fast and later entries are written", async () => {
    expect(
      app.auxDb.get<{ timeout: number }>("PRAGMA busy_timeout")!.timeout,
    ).toBe(100);
    const other = new Database(join(app.dataDir, "auxiliary.db"));
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      other.run("BEGIN IMMEDIATE");
      app.logger.warn("dropped");
      await app.logger.flush();
      expect(err.mock.calls.map((c) => c[0])).toEqual(["Failed to write log"]);
      other.run("COMMIT");
      app.logger.warn("written");
      await app.logger.flush();
    } finally {
      err.mockRestore();
      other.close();
    }
    expect(rows().map((r) => r.message)).toEqual(["written"]);
  });

  test("settings reload deletes old and low-level rows and vacuums at maxDays 0", async () => {
    await insert(8, "2026-01-07 11:59:59.000Z");
    await insert(8, "2026-01-08 12:00:00.000Z");
    await insert(8, "2026-01-08 12:00:01.000Z");
    await insert(0, "2026-01-10 11:00:00.000Z");
    await app.settings.update({ logs: { maxDays: 2, minLevel: 4 } });
    expect(rows().map((r) => r.created)).toEqual(["2026-01-08 12:00:01.000Z"]);

    const text = "x".repeat(2000);
    await app.auxDb.write(() => {
      for (let i = 0; i < 100; i++)
        app.auxDb.run(
          "INSERT INTO _logs (id, level, message, data, created) VALUES (?, 8, ?, '{}', ?)",
          [`v${i}`, text, "2026-01-10 11:00:00.000Z"],
        );
    });
    await app.auxDb.write(() => app.auxDb.run("DELETE FROM _logs"));
    const freelist = () =>
      app.auxDb.get<{ freelist_count: number }>("PRAGMA freelist_count")!
        .freelist_count;
    expect(freelist()).toBeGreaterThan(0);
    await insert(8, "2026-01-10 11:00:00.000Z");
    await app.settings.update({ logs: { maxDays: 0 } });
    expect(rows()).toHaveLength(0);
    expect(freelist()).toBe(0);
  });

  test("__pbLogsCleanup__ deletes rows older than maxDays", async () => {
    await insert(0, "2026-01-05 12:00:00.000Z");
    await insert(0, "2026-01-05 12:00:00.001Z");
    await app.scheduler
      .jobs()
      .find((j) => j.id === "__pbLogsCleanup__")!
      .run();
    expect(rows().map((r) => r.created)).toEqual(["2026-01-05 12:00:00.001Z"]);
  });
});

test("terminate flushes queued entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "heybe-logs-"));
  try {
    const clock = fakeClock();
    const app = createApp({
      dir,
      argv: [],
      now: clock.now,
      timers: clock.timers,
    });
    await app.bootstrap();
    app.logger.warn("queued", { a: 1 });
    await app.terminate();
    const aux = openAuxDb(join(dir, "auxiliary.db"));
    expect(
      aux.query<Row>("SELECT message, data FROM _logs").map((r) => ({
        message: r.message,
        data: r.data,
      })),
    ).toEqual([{ message: "queued", data: '{"a":1}' }]);
    aux.close();
    expect(clock.pending()).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
