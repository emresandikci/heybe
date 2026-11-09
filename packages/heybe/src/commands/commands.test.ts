import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, type AppOptions, createApp } from "../app";
import { testApp } from "../test-app";
import { fakeClock } from "../test-clock";
import { superuserCommand } from "./superuser";

let app: App;
let out: string[];
let err: string[];

beforeEach(() => {
  app = testApp({ argv: [] });
  out = [];
  err = [];
  spyOn(console, "log").mockImplementation((...a) => {
    out.push(a.join(" "));
  });
  spyOn(console, "error").mockImplementation((...a) => {
    err.push(a.join(" "));
  });
});

afterEach(() => {
  app.close();
  mock.restore();
});

const run = (...args: string[]) => superuserCommand(args, app);
const failure = async (...args: string[]) =>
  run(...args).then(
    () => "",
    (e: Error) => e.message,
  );
const find = async (email: string) =>
  (await app.records("_superusers").findMany({ where: { email } })).items[0];

describe("superuser", () => {
  test("upsert, create, update and delete", async () => {
    await run("upsert", "a@example.com", "1234567890");
    expect(out.at(-1)).toBe('Successfully saved superuser "a@example.com"!');
    const first = await find("a@example.com");
    await run("upsert", "a@example.com", "1234567890!");
    expect(out.at(-1)).toBe('Successfully saved superuser "a@example.com"!');
    expect((await find("a@example.com"))?.id).toBe(first?.id);

    await run("create", "b@example.com", "1234567890");
    expect(out.at(-1)).toBe(
      'Successfully created new superuser "b@example.com"!',
    );
    await run("update", "b@example.com", "0987654321");
    expect(out.at(-1)).toBe(
      'Successfully changed superuser "b@example.com" password!',
    );
    await run("delete", "b@example.com");
    expect(out.at(-1)).toBe('Successfully deleted superuser "b@example.com"!');
    expect(await find("b@example.com")).toBeUndefined();
    await run("delete", "b@example.com");
    expect(out.at(-1)).toBe(
      'superuser "b@example.com" is missing or already deleted',
    );
  });

  test("argument errors", async () => {
    for (const sub of ["upsert", "create", "update"]) {
      expect(await failure(sub)).toBe("missing email and password arguments");
      expect(await failure(sub, "", "")).toBe(
        "missing or invalid email address",
      );
      expect(await failure(sub, "invalid", "1234567890")).toBe(
        "missing or invalid email address",
      );
    }
    for (const sub of ["delete", "otp"]) {
      expect(await failure(sub)).toBe("invalid or missing email address");
      expect(await failure(sub, "invalid")).toBe(
        "invalid or missing email address",
      );
    }
  });

  test("password and missing superuser errors", async () => {
    expect(await failure("upsert", "a@example.com", "")).toStartWith(
      "failed to upsert superuser account: password: ",
    );
    expect(await failure("create", "a@example.com", "1234567")).toStartWith(
      "failed to create new superuser account: password: ",
    );
    expect(await failure("update", "a@example.com", "1234567890")).toBe(
      'superuser with email "a@example.com" doesn\'t exist',
    );
    expect(await failure("otp", "a@example.com")).toBe(
      'superuser with email "a@example.com" doesn\'t exist',
    );
  });

  test("otp requires it to be enabled and prints id, code and duration", async () => {
    await run("create", "a@example.com", "1234567890");
    expect(await failure("otp", "a@example.com")).toBe(
      "OTP auth is not enabled for the _superusers collection",
    );
    const c = app.collections.find("_superusers")!;
    await app.collections.save({
      id: c.id,
      otp: { ...(c.otp as object), enabled: true },
    } as any);
    await run("otp", "a@example.com");
    const { length, duration } = app.collections.find("_superusers")!.otp as {
      length: number;
      duration: number;
    };
    expect(out.at(-3)).toStartWith("├─ Id:    ");
    expect(out.at(-2)).toMatch(new RegExp(`^├─ Pass:  \\d{${length}}$`));
    expect(out.at(-1)).toBe(`└─ Valid: ${duration}s\n`);
    const id = out.at(-3)?.slice("├─ Id:    ".length);
    expect(
      app.db.get("SELECT id FROM _otps WHERE id = ?", [id]),
    ).not.toBeNull();
  });

  test("ips sets and clears the whitelist", async () => {
    await run("ips", "127.0.0.1", "::1", "127.0.0.1/24");
    expect(out.slice(-4)).toEqual([
      "Successfully updated SuperuserIPs setting:",
      "├─ 127.0.0.1",
      "├─ ::1",
      "└─ 127.0.0.1/24",
    ]);
    expect(app.settings.get().superuserIPs).toEqual([
      "127.0.0.1",
      "::1",
      "127.0.0.1/24",
    ]);
    expect(await failure("ips", "127.0.0.1", "invalid")).toBeTruthy();
    await run("ips");
    expect(out.at(-1)).toBe("Successfully cleared SuperuserIPs setting!");
    expect(app.settings.get().superuserIPs).toEqual([]);
  });
});

describe("start", () => {
  test("a custom command runs between onBootstrap and onTerminate", async () => {
    const order: string[] = [];
    const received: string[][] = [];
    const cli = testApp({ argv: ["hello", "a", "b"] });
    cli.onBootstrap(async (e) => {
      order.push("bootstrap");
      await e.next();
    });
    cli.onTerminate(async (e) => {
      order.push("terminate");
      await e.next();
    });
    cli.command("hello", (args) => {
      order.push("command");
      received.push(args);
    });
    expect(await cli.start()).toBe(0);
    expect(order).toEqual(["bootstrap", "command", "terminate"]);
    expect(received).toEqual([["a", "b"]]);
  });

  test("a duplicate command name throws", () => {
    expect(() => app.command("serve", () => {})).toThrow();
    app.command("x", () => {});
    expect(() => app.command("x", () => {})).toThrow();
  });

  test("an unknown or missing command prints the usage and exits 1", async () => {
    for (const argv of [["nope"], []]) {
      const cli = testApp({ argv });
      expect(await cli.start()).toBe(1);
      expect(err.at(-1)).toContain("serve");
      expect(err.at(-1)).toContain("superuser");
    }
  });

  test("a failing command prints the error and exits 1", async () => {
    const cli = testApp({ argv: ["boom"] });
    cli.command("boom", () => {
      throw new Error("bad");
    });
    const terminated = mock(() => {});
    cli.onTerminate(async (e) => {
      terminated();
      await e.next();
    });
    expect(await cli.start()).toBe(1);
    expect(terminated).toHaveBeenCalledTimes(1);
    expect(err.at(-1)).toBe("Error: bad");
  });

  test("global flags come from argv and explicit options win", () => {
    const dir = mkdtempSync(join(tmpdir(), "heybe-cmd-"));
    try {
      const flagged = createApp({
        argv: [
          "serve",
          "--dir",
          dir,
          "--dev",
          "--automigrate=false",
          "--migrationsDir",
          "m",
        ],
      });
      expect(flagged.dev).toBe(true);
      expect(flagged.automigrate).toBe(false);
      expect(flagged.migrationsDir).toBe("m");
      expect(flagged.db.get("SELECT 1 AS one")).toEqual({ one: 1 });
      flagged.close();

      const explicit = testApp({ dev: false, argv: ["--dev"] });
      expect(explicit.dev).toBe(false);
      explicit.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lifecycle", () => {
  test("an onBootstrap handler without next() skips the settings reload and the command still runs", async () => {
    const cli = testApp({ argv: ["hello"] });
    const reload = spyOn(cli.settings, "reload");
    cli.onBootstrap(() => {});
    const ran = mock(() => {});
    cli.command("hello", ran);
    expect(await cli.start()).toBe(0);
    expect(reload).not.toHaveBeenCalled();
    expect(ran).toHaveBeenCalledTimes(1);
  });

  test("bootstrap runs once and is skipped for unknown commands", async () => {
    const cli = testApp({ argv: ["hello"] });
    const boots = mock(() => {});
    cli.onBootstrap(async (e) => {
      boots();
      await e.next();
    });
    cli.command("hello", () => {});
    await cli.bootstrap();
    await cli.start();
    expect(boots).toHaveBeenCalledTimes(1);

    const unknown = testApp({ argv: ["nope"] });
    unknown.onBootstrap(async (e) => {
      boots();
      await e.next();
    });
    expect(await unknown.start()).toBe(1);
    expect(boots).toHaveBeenCalledTimes(1);
  });

  test("a throwing onTerminate handler still closes the db and returns 1", async () => {
    const cli = testApp({ argv: ["hello"] });
    cli.command("hello", () => {});
    cli.onTerminate(() => {
      throw new Error("terminate failed");
    });
    expect(await cli.start()).toBe(1);
    expect(err.at(-1)).toBe("Error: terminate failed");
    expect(() => cli.db.get("SELECT 1")).toThrow();
  });

  test("a throwing onBootstrap handler fails the command, terminates and closes", async () => {
    const cli = testApp({ argv: ["hello"] });
    const ran = mock(() => {});
    cli.command("hello", ran);
    cli.onBootstrap(() => {
      throw new Error("bootstrap failed");
    });
    expect(await cli.start()).toBe(1);
    expect(ran).not.toHaveBeenCalled();
    expect(() => cli.db.get("SELECT 1")).toThrow();
  });

  test("the automigrate flag forms", () => {
    const flag = (...argv: string[]) => {
      const cli = testApp({ argv: ["x", ...argv] });
      const value = cli.automigrate;
      cli.close();
      return value;
    };
    expect(flag()).toBe(true);
    expect(flag("--automigrate")).toBe(true);
    expect(flag("--automigrate=true")).toBe(true);
    expect(flag("--automigrate=false")).toBe(false);
    expect(flag("--automigrate=0")).toBe(false);
  });

  test("the typegen command writes the types file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "heybe-typegen-"));
    try {
      const out = join(dir, "types.d.ts");
      const cli = testApp({ argv: ["typegen", "--out", out] });
      expect(await cli.start()).toBe(0);
      expect(await Bun.file(out).text()).toContain(
        'declare module "@heybe/query"',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unknown superuser subcommand fails with the usage", async () => {
    expect(await failure("nope")).toStartWith("usage: superuser");
    expect(await failure()).toStartWith("usage: superuser");
  });

  const startServe = async (
    clock = fakeClock(),
    execve?: AppOptions["execve"],
  ) => {
    const cli = testApp({
      timers: clock.timers,
      argv: ["serve", "--http", "127.0.0.1:0"],
      execve,
    });
    let url = "";
    const started = new Promise<void>((resolve) => {
      spyOn(console, "log").mockImplementation((line: string) => {
        const m = /^Server started at (.+)$/.exec(String(line));
        if (m) {
          url = m[1]!;
          resolve();
        }
      });
    });
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    cli.get("/slow", async (e) => {
      entered.resolve();
      await gate.promise;
      return e.string(200, "done");
    });
    const events: string[] = [];
    const up = () =>
      fetch(`${url}/api/health`).then(
        () => "up",
        () => "down",
      );
    cli.onTerminate(async (e) => {
      events.push(`handler:${await up()}`);
      await e.next();
      events.push("after");
    });
    const done = cli.start();
    await started;
    return { cli, url: () => url, gate, entered, events, up, done };
  };

  test("serve stops the server before the user terminate handlers, like PB", async () => {
    const warn = spyOn(console, "warn");
    const s = await startServe();
    process.emit("SIGINT");
    expect(await s.done).toBe(0);
    expect(s.events).toEqual(["handler:down", "after"]);
    expect(warn).not.toHaveBeenCalled();
    expect(await s.up()).toBe("down");
  });

  test("a restart whose execve fails ends serve, like PB", async () => {
    const warn = spyOn(console, "warn");
    const s = await startServe(fakeClock(), () => {
      throw new Error("boom");
    });
    await expect(s.cli.restart()).rejects.toThrow("boom");
    expect(await s.done).toBe(0);
    expect(await s.up()).toBe("down");
    expect(warn).not.toHaveBeenCalled();
  });

  test("an in-flight request finishes before the server stops", async () => {
    const s = await startServe();
    const slow = fetch(`${s.url()}/slow`).then((r) => r.text());
    await s.entered.promise;
    process.emit("SIGINT");
    await new Promise((resolve) => setImmediate(resolve));
    expect(s.events).toEqual([]);
    s.gate.resolve();
    expect(await slow).toBe("done");
    expect(await s.done).toBe(0);
    expect(s.events).toEqual(["handler:down", "after"]);
  });

  test("a request still running after 1 s is closed", async () => {
    const clock = fakeClock();
    const s = await startServe(clock);
    const slow = fetch(`${s.url()}/slow`).then(
      () => "answered",
      () => "closed",
    );
    await s.entered.promise;
    const timeout = clock.scheduled();
    process.emit("SIGINT");
    await timeout;
    clock.advance(999);
    await new Promise((resolve) => setImmediate(resolve));
    expect(s.events).toEqual([]);
    clock.advance(1);
    expect(await slow).toBe("closed");
    expect(await s.done).toBe(0);
    expect(s.events).toEqual(["handler:down", "after"]);
    s.gate.resolve();
  });

  test("serve ends the realtime connections on terminate", async () => {
    const s = await startServe();
    const res = await fetch(`${s.url()}/api/realtime`);
    const reader = res.body!.getReader();
    await reader.read();
    expect(s.cli.realtime.clients()).toHaveLength(1);
    process.emit("SIGINT");
    for (;;) if ((await reader.read()).done) break;
    expect(await s.done).toBe(0);
    expect(s.events).toEqual(["handler:down", "after"]);
  });

  test("terminate clears the bootstrap through onBootstrapClear", async () => {
    const cli = testApp({ argv: [] });
    const cleared = mock(() => {});
    cli.onBootstrapClear(async (e) => {
      cleared();
      await e.next();
    });
    await cli.terminate();
    expect(cleared).not.toHaveBeenCalled();
    await cli.bootstrap();
    await cli.terminate();
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(() => cli.db.get("SELECT 1")).toThrow();
  });

  test("an onBootstrapClear handler without next() keeps the db open", async () => {
    const cli = testApp({ argv: [] });
    cli.onBootstrapClear(() => {});
    await cli.bootstrap();
    await cli.terminate();
    expect(cli.db.get("SELECT 1 AS one")).toEqual({ one: 1 });
    cli.close();
  });
});
