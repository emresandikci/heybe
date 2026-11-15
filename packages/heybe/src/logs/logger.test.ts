import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, createApp } from "../app";
import { fakeClock } from "../test-clock";
import { testApp } from "../test-app";
import { exclusive } from "../db";
import { openAuxDb } from "./aux-db";
import { createLogger } from "./logger";

const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeWorker {
  static all: FakeWorker[] = [];
  posted: { id: number; rows: unknown[][] }[] = [];
  terminated = false;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  private closeListeners: (() => void)[] = [];
  constructor() {
    FakeWorker.all.push(this);
  }
  ref() {}
  unref() {}
  answer() {
    this.onmessage!({ data: { id: this.posted.at(-1)!.id } });
  }
  postMessage(m: { id: number; rows: unknown[][] }) {
    this.posted.push(m);
  }
  addEventListener(_: string, fn: () => void) {
    this.closeListeners.push(fn);
  }
  terminate() {
    this.terminated = true;
  }
  exit() {
    for (const fn of this.closeListeners) fn();
  }
}

async function withFakeWorker(fn: () => Promise<void>) {
  const real = globalThis.Worker;
  FakeWorker.all = [];
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  try {
    await fn();
  } finally {
    globalThis.Worker = real;
  }
}

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
    expect(clock.pending()).toBe(0);
    await app.logger.flush();
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
    expect(clock.pending()).toBe(1);
    clock.advance(1);
    expect(clock.pending()).toBe(0);
    await app.logger.flush();
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

  test("a closed logger does not throw from log or flush", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      (app.logger as ReturnType<typeof createLogger>).close();
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

  test("rows written through the worker are readable from app.auxDb after flush", async () => {
    app.logger.info("a", { x: 1 });
    app.logger.warn("b");
    await app.logger.flush();
    expect(rows().map((r) => [r.message, r.level, r.data])).toEqual([
      ["a", 0, '{"x":1}'],
      ["b", 4, "{}"],
    ]);
  });

  test('a batch the worker rejects logs "Failed to write log" and the next batch still lands', async () => {
    await app.auxDb.write(() =>
      app.auxDb.run(
        "CREATE TRIGGER fail BEFORE INSERT ON _logs WHEN NEW.message = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END",
      ),
    );
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      app.logger.info("kept?");
      app.logger.info("boom");
      await app.logger.flush();
      expect(err.mock.calls.map((c) => [c[0], String(c[1])])).toEqual([
        ["Failed to write log", "Error: boom"],
      ]);
      app.logger.info("next");
      await app.logger.flush();
    } finally {
      err.mockRestore();
    }
    expect(rows().map((r) => r.message)).toEqual(["next"]);
  });

  test("a batch waiting on the aux mutex when the logger closes starts no worker", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      await withFakeWorker(async () => {
        let open: (() => void) | undefined;
        const held = exclusive(
          app.auxDb,
          () => new Promise<void>((r) => (open = r)),
        );
        while (!open) await tick();
        app.logger.info("late");
        const flushed = app.logger.flush();
        (app.logger as ReturnType<typeof createLogger>).close();
        open!();
        await held;
        await flushed;
        expect(FakeWorker.all).toHaveLength(0);
      });
      expect(err.mock.calls.map((c) => [c[0], String(c[1])])).toEqual([
        ["Failed to write log", "Error: the app is closed"],
      ]);
    } finally {
      err.mockRestore();
    }
  });

  test("a worker that exits mid-batch drops the batch and frees the aux mutex", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      await withFakeWorker(async () => {
        app.logger.info("lost");
        const flushed = app.logger.flush();
        while (FakeWorker.all[0]?.posted.length !== 1) await tick();
        FakeWorker.all[0]!.exit();
        await flushed;
        await exclusive(app.auxDb, () => {});
        app.logger.info("next");
        void app.logger.flush();
        while (FakeWorker.all[1]?.posted.length !== 1) await tick();
        (app.logger as ReturnType<typeof createLogger>).close();
        await app.logger.flush();
      });
      expect(err.mock.calls[0]!.map(String)).toEqual([
        "Failed to write log",
        "Error: log worker exited",
      ]);
    } finally {
      err.mockRestore();
    }
  });

  test("batches over the backlog cap are dropped with one error", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      await withFakeWorker(async () => {
        // one batch in flight, 250 backlogged, the next two dropped
        for (let i = 0; i < 253 * 200; i++) app.logger.info("m");
        expect(err.mock.calls.map((c) => [c[0], String(c[1])])).toEqual([
          ["Failed to write log", "Error: the log worker is behind, dropping"],
        ]);
        (app.logger as ReturnType<typeof createLogger>).close();
        await app.logger.flush();
      });
    } finally {
      err.mockRestore();
    }
  });

  test("rows backlogged while a batch is in flight go in one transaction", async () => {
    await withFakeWorker(async () => {
      for (let i = 0; i < 600; i++) app.logger.info("m");
      while (FakeWorker.all[0]?.posted.length !== 1) await tick();
      const worker = FakeWorker.all[0]!;
      const posts = () => worker.posted.length;
      worker.answer();
      while (posts() !== 2) await tick();
      worker.answer();
      app.logger.info("last");
      const flushed = app.logger.flush();
      while (posts() !== 3) await tick();
      worker.answer();
      await flushed;
      expect(worker.posted.map((m) => m.rows.length)).toEqual([200, 400, 1]);
    });
  });

  test("release then log again writes through a new worker", async () => {
    app.logger.info("a");
    await app.logger.release();
    expect(rows().map((r) => r.message)).toEqual(["a"]);
    app.logger.info("b");
    await app.logger.flush();
    expect(rows().map((r) => r.message)).toEqual(["a", "b"]);
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
