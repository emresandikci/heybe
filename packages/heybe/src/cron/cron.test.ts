import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type App } from "../app";
import { testApp } from "../test-app";
import { otpDurationMs } from "../auth/otp";
import { mfaDurationMs } from "../auth/mfa";
import { Cron } from "../extend/cron";
import { ServeEvent } from "../hooks/events";
import { Schedule, momentOf } from "./schedule";
import { CronScheduler } from "./scheduler";
import { fakeClock } from "../test-clock";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const moment = (
  minute: number,
  hour = 0,
  day = 1,
  month = 1,
  dayOfWeek = 0,
) => ({
  minute,
  hour,
  day,
  month,
  dayOfWeek,
});

describe("Schedule.parse", () => {
  test.each([
    ["@yearly", "0 0 1 1 *"],
    ["@annually", "0 0 1 1 *"],
    ["@monthly", "0 0 1 * *"],
    ["@weekly", "0 0 * * 0"],
    ["@daily", "0 0 * * *"],
    ["@midnight", "0 0 * * *"],
    ["@hourly", "0 * * * *"],
    ["*/5 1-3 * * 1,3", "*/5 1-3 * * 1,3"],
  ])("expands %s", (expr, expanded) => {
    expect(Schedule.parse(expr).expression).toBe(expanded);
  });

  test.each([
    [
      "",
      "invalid cron expression - must be a valid macro or to have exactly 5 space separated segments",
    ],
    [
      "* * * *",
      "invalid cron expression - must be a valid macro or to have exactly 5 space separated segments",
    ],
    [
      "*  * * * *",
      "invalid cron expression - must be a valid macro or to have exactly 5 space separated segments",
    ],
    [
      "@reboot",
      "invalid cron expression - must be a valid macro or to have exactly 5 space separated segments",
    ],
    ["a * * * *", 'strconv.Atoi: parsing "a": invalid syntax'],
    ["* * * * jan", 'strconv.Atoi: parsing "jan": invalid syntax'],
    [
      "99999999999999999999 * * * *",
      'strconv.Atoi: parsing "99999999999999999999": value out of range',
    ],
    [
      "60 * * * *",
      "invalid segment value - must be between the min and max of the segment",
    ],
    [
      "* 24 * * *",
      "invalid segment value - must be between the min and max of the segment",
    ],
    [
      "* * 0 * *",
      "invalid segment value - must be between the min and max of the segment",
    ],
    [
      "* * * 13 *",
      "invalid segment value - must be between the min and max of the segment",
    ],
    [
      "* * * * 7",
      "invalid segment value - must be between the min and max of the segment",
    ],
    [
      "*/0 * * * *",
      "invalid segment step boundary - the step must be between 1 and the 59",
    ],
    [
      "*/60 * * * *",
      "invalid segment step boundary - the step must be between 1 and the 59",
    ],
    ["*/x * * * *", 'strconv.Atoi: parsing "x": invalid syntax'],
    [
      "*/1/2 * * * *",
      "invalid segment step format - must be in the format */n or 1-30/n",
    ],
    [
      "5/2 * * * *",
      "invalid segment step - step > 1 could be used only with the wildcard or range format",
    ],
    [
      "60-70 * * * *",
      "invalid segment range minimum - must be between 0 and 59",
    ],
    [
      "10-70 * * * *",
      "invalid segment range maximum - must be between 10 and 59",
    ],
    [
      "20-10 * * * *",
      "invalid segment range maximum - must be between 20 and 59",
    ],
    [
      "1-2-3 * * * *",
      "invalid segment range format - the range must have 1 or 2 parts",
    ],
    ["-5 * * * *", 'strconv.Atoi: parsing "": invalid syntax'],
  ])("rejects %j", (expr, message) => {
    expect(() => Schedule.parse(expr)).toThrow(new Error(message));
  });

  test("isDue needs all five fields, day and weekday are ANDed", () => {
    const s = Schedule.parse("*/15 8-10 1,15 * 1");
    expect(s.isDue(moment(30, 9, 15, 6, 1))).toBe(true);
    expect(s.isDue(moment(31, 9, 15, 6, 1))).toBe(false);
    expect(s.isDue(moment(30, 11, 15, 6, 1))).toBe(false);
    expect(s.isDue(moment(30, 9, 16, 6, 1))).toBe(false);
    expect(s.isDue(moment(30, 9, 15, 6, 2))).toBe(false);
    expect(Schedule.parse("0 0 1 6 *").isDue(moment(0, 0, 1, 7))).toBe(false);
    expect(Schedule.parse("10-20/5 * * * *").isDue(moment(15))).toBe(true);
    expect(Schedule.parse("10-20/5 * * * *").isDue(moment(16))).toBe(false);
  });

  test("momentOf follows the timezone", () => {
    const date = new Date("2026-03-01T23:30:00Z");
    expect(momentOf(date, "UTC")).toEqual(moment(30, 23, 1, 3, 0));
    expect(momentOf(date, "Asia/Tokyo")).toEqual(moment(30, 8, 2, 3, 1));
  });
});

describe("CronScheduler", () => {
  let clock: ReturnType<typeof fakeClock>;
  let scheduler: CronScheduler;

  beforeEach(() => {
    clock = fakeClock("2026-01-01T12:00:30Z");
    scheduler = new CronScheduler(clock.timers, clock.now);
  });
  afterEach(() => void scheduler.stop());

  test("wraps parse errors", () => {
    expect(() => scheduler.add("a", "nope", () => {})).toThrow(
      "failed to add new cron job: invalid cron expression - must be a valid macro or to have exactly 5 space separated segments",
    );
  });

  test("first tick at the next interval boundary, then every interval", () => {
    const runs: string[] = [];
    scheduler.add("a", "* * * * *", () => {
      runs.push(clock.now().toISOString());
    });
    scheduler.start();
    expect(scheduler.hasStarted()).toBe(false);
    clock.advance(29_999);
    expect(runs).toEqual([]);
    clock.advance(1);
    expect(scheduler.hasStarted()).toBe(true);
    clock.advance(120_000);
    expect(runs).toEqual([
      "2026-01-01T12:01:00.000Z",
      "2026-01-01T12:02:00.000Z",
      "2026-01-01T12:03:00.000Z",
    ]);
  });

  test("a timer firing early still runs the intended minute once, without drift", () => {
    let time = Date.parse("2026-01-01T12:00:30Z");
    const timeouts: { fn: () => void; ms: number }[] = [];
    const early = new CronScheduler(
      {
        setTimeout: (fn, ms) => timeouts.push({ fn, ms }),
        clearTimeout: () => {},
      },
      () => new Date(time),
    );
    const runs: string[] = [];
    early.add("a", "* * * * *", () => {
      runs.push("12:0" + new Date(time).getUTCMinutes());
    });
    early.start();
    expect(timeouts[0]!.ms).toBe(30_000);
    time = Date.parse("2026-01-01T12:00:59.900Z");
    timeouts[0]!.fn();
    expect(timeouts[1]!.ms).toBe(60_100);
    time = Date.parse("2026-01-01T12:02:00.200Z");
    timeouts[1]!.fn();
    expect(timeouts[2]!.ms).toBe(59_800);
    expect(runs).toHaveLength(2);
  });

  test("a long pause runs the stale tick once and resumes at the next boundary", () => {
    let time = Date.parse("2026-01-01T12:00:30Z");
    const timeouts: { fn: () => void; ms: number }[] = [];
    const paused = new CronScheduler(
      {
        setTimeout: (fn, ms) => timeouts.push({ fn, ms }),
        clearTimeout: () => {},
      },
      () => new Date(time),
    );
    let runs = 0;
    paused.add("a", "* * * * *", () => {
      runs++;
    });
    paused.start();
    time = Date.parse("2026-01-01T12:10:20Z");
    timeouts[0]!.fn();
    expect(runs).toBe(1);
    expect(timeouts).toHaveLength(2);
    expect(timeouts[1]!.ms).toBe(40_000);
  });

  test("an invalid timezone is rejected up front", () => {
    expect(() => scheduler.setTimezone("Mars/Base")).toThrow();
    expect(() => scheduler.setTimezone("Europe/Berlin")).not.toThrow();
  });

  test("only due jobs run", async () => {
    const runs: string[] = [];
    scheduler.add("every", "* * * * *", () => void runs.push("every"));
    scheduler.add("half", "30 * * * *", () => void runs.push("half"));
    scheduler.runDue(new Date("2026-01-01T12:01:00Z"));
    await tick();
    expect(runs).toEqual(["every"]);
  });

  test("a throwing job and a never resolving job do not stop another job or the next tick", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const runs: number[] = [];
    scheduler.add("boom", "* * * * *", () => {
      throw new Error("boom");
    });
    scheduler.add("async-boom", "* * * * *", async () => {
      throw new Error("later");
    });
    scheduler.add("hang", "* * * * *", () => new Promise(() => {}));
    scheduler.add("ok", "* * * * *", () => void runs.push(1));
    scheduler.start();
    clock.advance(30_000);
    await tick();
    clock.advance(60_000);
    await tick();
    expect(runs).toEqual([1, 1]);
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });

  test("a duplicate id replaces the job and moves it last", () => {
    scheduler.add("a", "* * * * *", () => {});
    scheduler.add("b", "* * * * *", () => {});
    scheduler.add("a", "@hourly", () => {});
    expect(scheduler.jobs().map((j) => [j.id, j.expression])).toEqual([
      ["b", "* * * * *"],
      ["a", "0 * * * *"],
    ]);
    expect(scheduler.total()).toBe(2);
    scheduler.remove("b");
    expect(scheduler.total()).toBe(1);
    scheduler.removeAll();
    expect(scheduler.total()).toBe(0);
  });

  test("jobs keep insertion order and remove, removeAll and total work", () => {
    for (const id of ["c", "a", "b"]) scheduler.add(id, "* * * * *", () => {});
    expect(scheduler.jobs().map((j) => j.id)).toEqual(["c", "a", "b"]);
    expect(scheduler.total()).toBe(3);
    scheduler.remove("a");
    scheduler.remove("missing");
    expect(scheduler.jobs().map((j) => j.id)).toEqual(["c", "b"]);
    scheduler.removeAll();
    expect(scheduler.total()).toBe(0);
  });

  test("stop cancels the timers and start again restarts them", () => {
    let runs = 0;
    scheduler.add("a", "* * * * *", () => void runs++);
    scheduler.start();
    clock.advance(30_000);
    scheduler.stop();
    expect(scheduler.hasStarted()).toBe(false);
    expect(clock.pending()).toBe(0);
    clock.advance(300_000);
    expect(runs).toBe(1);
    scheduler.start();
    scheduler.start();
    expect(clock.pending()).toBe(1);
    clock.advance(60_000);
    expect(runs).toBe(2);
  });

  test("timezone decides which jobs are due", async () => {
    const runs: string[] = [];
    scheduler.add("a", "0 21 * * *", () => void runs.push("a"));
    scheduler.setTimezone("Asia/Tokyo");
    scheduler.runDue(new Date("2026-01-01T12:00:00Z"));
    await tick();
    expect(runs).toEqual(["a"]);
  });

  test("setInterval changes the tick of a started scheduler", () => {
    let runs = 0;
    scheduler.add("a", "* * * * *", () => void runs++);
    scheduler.start();
    clock.advance(30_000);
    scheduler.setInterval(10_000);
    clock.advance(10_000);
    expect(runs).toBe(2);
  });

  test("stop waits for the running jobs", async () => {
    const gate = Promise.withResolvers<void>();
    scheduler.add("slow", "* * * * *", () => gate.promise);
    scheduler.start();
    clock.advance(30_000);
    let stopped = false;
    const stopping = scheduler.stop().then(() => (stopped = true));
    await tick();
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;
    expect(stopped).toBe(true);
  });
});

describe("app cron", () => {
  let app: App;
  let clock: ReturnType<typeof fakeClock>;

  beforeEach(() => {
    clock = fakeClock("2026-01-01T12:00:30Z");
    app = testApp({ now: clock.now, timers: clock.timers });
  });
  afterEach(() => app.close());

  const ids = () => app.scheduler.jobs().map((j) => j.id);

  test("registers the system jobs in order", () => {
    expect(app.scheduler.jobs().map((j) => [j.id, j.expression])).toEqual([
      ["__pbDBOptimize__", "0 0 * * *"],
      ["__pbMFACleanup__", "0 * * * *"],
      ["__pbOTPCleanup__", "0 * * * *"],
      ["__pbLogsCleanup__", "0 */6 * * *"],
    ]);
  });

  test("generated ids count the two argument calls", () => {
    expect(app.cron("*/5 * * * *", () => {})).toBe("cron_1");
    expect(app.cron("named", "@daily", () => {})).toBe("named");
    expect(app.cron("*/5 * * * *", () => {})).toBe("cron_2");
    expect(ids().slice(-3)).toEqual(["cron_1", "named", "cron_2"]);
  });

  test("jobs get the app", async () => {
    const got: App[] = [];
    app.cron("a", "* * * * *", (a) => void got.push(a));
    await app.scheduler
      .jobs()
      .find((j) => j.id === "a")!
      .run();
    expect(got).toEqual([app]);
  });

  test("a Cron subclass is listed under its id or class name", async () => {
    const seen: App[] = [];
    class Cleanup extends Cron {
      schedule = "@hourly";
      run(a: App) {
        seen.push(a);
      }
    }
    class Custom extends Cron {
      id = "custom-id";
      schedule = "* * * * *";
      run() {}
    }
    app.register(Cleanup, Custom);
    expect(ids().slice(-2)).toEqual(["Cleanup", "custom-id"]);
    await app.scheduler
      .jobs()
      .find((j) => j.id === "Cleanup")!
      .run();
    expect(seen).toEqual([app]);
  });

  test("anonymous Cron classes get generated ids like app.cron", () => {
    const job = () =>
      class extends Cron {
        schedule = "* * * * *";
        run() {}
      };
    app.cron("* * * * *", () => {});
    app.register(job(), job());
    expect(ids().slice(-3)).toEqual(["cron_1", "cron_2", "cron_3"]);
  });

  test("the scheduler starts on serve and stops on terminate", async () => {
    await app.bootstrap();
    await app.hooks.onServe.trigger(
      ServeEvent.of({ app, router: app.router, server: null }),
      () => {},
    );
    expect(clock.pending()).toBe(1);
    clock.advance(30_000);
    expect(app.scheduler.hasStarted()).toBe(true);
    await app.terminate();
    expect(app.scheduler.hasStarted()).toBe(false);
  });

  test("terminate waits for a running job's write before closing the db", async () => {
    await app.bootstrap();
    const gate = Promise.withResolvers<void>();
    let rows = -1;
    app.cron("slow", "* * * * *", (a) =>
      a.db.write(async () => {
        await gate.promise;
        a.db.run("CREATE TABLE late (id INTEGER)");
        rows = a.db.query("SELECT * FROM late").length;
      }),
    );
    void app.scheduler
      .jobs()
      .find((j) => j.id === "slow")!
      .run();
    let terminated = false;
    const terminating = app.terminate().then(() => (terminated = true));
    await tick();
    expect(terminated).toBe(false);
    gate.resolve();
    await terminating;
    expect(rows).toBe(0);
    expect(() => app.db.get("SELECT 1")).toThrow();
  });

  test("__pbDBOptimize__ runs its pragmas outside a transaction", async () => {
    const warn = spyOn(console, "warn");
    await app.scheduler
      .jobs()
      .find((j) => j.id === "__pbDBOptimize__")!
      .run();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("OTP and MFA cleanup", () => {
  let app: App;
  let time: number;

  beforeEach(() => {
    time = Date.parse("2026-01-01T00:00:00Z");
    app = testApp({ now: () => new Date(time) });
  });
  afterEach(() => app.close());

  const count = (table: string) =>
    app.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n;
  const run = (id: string) =>
    app.scheduler
      .jobs()
      .find((j) => j.id === id)!
      .run();

  async function seed(table: "_otps" | "_mfas", collectionRef: string) {
    const data = table === "_otps" ? { password: "x" } : { method: "password" };
    await app.records(table).create({ collectionRef, recordRef: "r", ...data });
  }

  test.each([
    ["_otps", "__pbOTPCleanup__", otpDurationMs],
    ["_mfas", "__pbMFACleanup__", mfaDurationMs],
  ] as const)(
    "%s removes only expired rows through the delete hooks",
    async (table, job, durationMs) => {
      const users = app.collections.find("users")!;
      await app.collections.save({ name: "posts", fields: [] });
      const other = app.collections.find("posts")!;
      await seed(table, users.id);
      await seed(table, other.id);
      time += durationMs(users) + 1;
      await seed(table, users.id);
      const deleted: string[] = [];
      app.onRecordAfterDeleteSuccess(table, (e) => {
        deleted.push(e.record.collection.name);
        return e.next();
      });

      await run(job);

      expect(count(table)).toBe(2);
      expect(deleted).toEqual([table]);
      const left = app.db.query<{ collectionRef: string }>(
        `SELECT collectionRef FROM ${table}`,
      );
      expect(left.filter((r) => r.collectionRef === users.id)).toHaveLength(1);
    },
  );
});
