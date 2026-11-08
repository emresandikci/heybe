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
import { type App, createApp } from "../app";
import { superuserCommand } from "./superuser";

let app: App;
let out: string[];
let err: string[];

beforeEach(() => {
  app = createApp({ dir: ":memory:", argv: [] });
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
    const cli = createApp({ dir: ":memory:", argv: ["hello", "a", "b"] });
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
      const cli = createApp({ dir: ":memory:", argv });
      expect(await cli.start()).toBe(1);
      expect(err.at(-1)).toContain("serve");
      expect(err.at(-1)).toContain("superuser");
    }
  });

  test("a failing command prints the error and exits 1", async () => {
    const cli = createApp({ dir: ":memory:", argv: ["boom"] });
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

      const explicit = createApp({
        dir: ":memory:",
        dev: false,
        argv: ["--dev"],
      });
      expect(explicit.dev).toBe(false);
      explicit.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lifecycle", () => {
  test("an onBootstrap handler without next() skips the settings reload and the command still runs", async () => {
    const cli = createApp({ dir: ":memory:", argv: ["hello"] });
    const reload = spyOn(cli.settings, "reload");
    cli.onBootstrap(() => {});
    const ran = mock(() => {});
    cli.command("hello", ran);
    expect(await cli.start()).toBe(0);
    expect(reload).not.toHaveBeenCalled();
    expect(ran).toHaveBeenCalledTimes(1);
  });

  test("bootstrap runs once and is skipped for unknown commands", async () => {
    const cli = createApp({ dir: ":memory:", argv: ["hello"] });
    const boots = mock(() => {});
    cli.onBootstrap(async (e) => {
      boots();
      await e.next();
    });
    cli.command("hello", () => {});
    await cli.bootstrap();
    await cli.start();
    expect(boots).toHaveBeenCalledTimes(1);

    const unknown = createApp({ dir: ":memory:", argv: ["nope"] });
    unknown.onBootstrap(async (e) => {
      boots();
      await e.next();
    });
    expect(await unknown.start()).toBe(1);
    expect(boots).toHaveBeenCalledTimes(1);
  });

  test("a throwing onTerminate handler still closes the db and returns 1", async () => {
    const cli = createApp({ dir: ":memory:", argv: ["hello"] });
    cli.command("hello", () => {});
    cli.onTerminate(() => {
      throw new Error("terminate failed");
    });
    expect(await cli.start()).toBe(1);
    expect(err.at(-1)).toBe("Error: terminate failed");
    expect(() => cli.db.get("SELECT 1")).toThrow();
  });

  test("a throwing onBootstrap handler fails the command, terminates and closes", async () => {
    const cli = createApp({ dir: ":memory:", argv: ["hello"] });
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
      const cli = createApp({ dir: ":memory:", argv: ["x", ...argv] });
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
      const cli = createApp({
        dir: ":memory:",
        argv: ["typegen", "--out", out],
      });
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

  test("serve stops the server inside the terminate chain after a signal", async () => {
    const cli = createApp({
      dir: ":memory:",
      argv: ["serve", "--http", "127.0.0.1:0"],
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
    const events: string[] = [];
    cli.onTerminate(async (e) => {
      events.push(`alive:${(await fetch(`${url}/api/health`)).ok}`);
      await e.next();
      events.push("after");
    });
    const done = cli.start();
    await started;
    process.emit("SIGINT");
    expect(await done).toBe(0);
    expect(events).toEqual(["alive:true", "after"]);
    expect(
      await fetch(`${url}/api/health`).then(
        () => "up",
        () => "down",
      ),
    ).toBe("down");
  });
});
