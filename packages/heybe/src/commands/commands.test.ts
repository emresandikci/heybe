import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import pkg from "../../package.json" with { type: "json" };
import { type App, type AppOptions, createApp } from "../app";
import { testApp } from "../test-app";
import { fakeClock } from "../test-clock";
import type { Timers } from "../timers";
import type { TlsCert } from "../http/autocert";
import { serveAddrs } from "./serve";
import { writePbDataDir } from "../import/pb-fixture";
import { superuserCommand } from "./superuser";

let app: App;
let out: string[];
let err: string[];
let stdout: string[];

beforeEach(() => {
  app = testApp({ argv: [] });
  out = [];
  err = [];
  stdout = [];
  spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
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

  test("no command prints the root help and exits 0", async () => {
    const cli = testApp({ argv: [] });
    expect(await cli.start()).toBe(0);
    const text = stdout.join("");
    expect(text).toStartWith("heybe CLI\n");
    expect(text).toContain("  -v, --version");
    expect(text).toContain("  superuser ");
  });

  test("an unknown command prints the cobra error and exits 1", async () => {
    const cli = testApp({ argv: ["nope"] });
    expect(await cli.start()).toBe(1);
    expect(err.at(-1)).toMatch(
      /^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d unknown command "nope" for "heybe"$/,
    );
  });

  test("--version wins over a command and never boots it", async () => {
    const serve = mock(() => {});
    const cli = testApp({ argv: ["--version", "serve"] });
    cli.onBootstrap(async (e) => {
      serve();
      await e.next();
    });
    expect(await cli.start()).toBe(0);
    expect(stdout.join("")).toBe(`heybe version ${pkg.version}\n`);
    expect(serve).not.toHaveBeenCalled();
  });

  test("superuser without or with an unknown subcommand prints its help", async () => {
    for (const argv of [["superuser"], ["superuser", "nope"]]) {
      stdout.length = 0;
      expect(await testApp({ argv }).start()).toBe(0);
      expect(stdout.join("")).toStartWith("Manage superusers\n");
    }
  });

  test("unknown flags fail per command", async () => {
    for (const [argv, message] of [
      [["serve", "--bogus"], "unknown flag: --bogus"],
      [["superuser", "upsert", "--bogus"], "unknown flag: --bogus"],
      [["serve", "-v"], "unknown shorthand flag: 'v' in -v"],
      [["serve", "--version"], "unknown flag: --version"],
    ] as const) {
      expect(await testApp({ argv: [...argv] }).start()).toBe(1);
      expect(err.at(-1)).toEndWith(` ${message}`);
    }
  });

  test("a leading unknown flag swallows the next argument and prints the root help", async () => {
    for (const argv of [
      ["--bogus", "serve"],
      ["--dir", "--help"],
    ]) {
      stdout.length = 0;
      expect(await testApp({ argv }).start()).toBe(0);
      expect(stdout.join("")).toStartWith("heybe CLI\n");
    }
  });

  test("a string flag takes --help as its value", async () => {
    const cli = testApp({ argv: ["serve", "--http", "--help"] });
    expect(await cli.start()).toBe(1);
    expect(stdout.join("")).toBe("");
  });

  test("--version prints the package version", async () => {
    for (const flag of ["--version", "-v"]) {
      stdout.length = 0;
      expect(await testApp({ argv: [flag] }).start()).toBe(0);
      expect(stdout.join("")).toBe(`heybe version ${pkg.version}\n`);
    }
  });

  test("--help prints the deepest matching command help without bootstrapping", async () => {
    const boots = mock(() => {});
    for (const [argv, title] of [
      [["serve", "--http", "127.0.0.1:0", "--help"], "Starts the web server"],
      [["superuser", "upsert", "-h"], "Creates, or updates"],
      [["--help"], "heybe CLI"],
    ] as const) {
      stdout.length = 0;
      const cli = testApp({ argv: [...argv] });
      cli.onBootstrap(async (e) => {
        boots();
        await e.next();
      });
      expect(await cli.start()).toBe(0);
      expect(stdout.join("")).toStartWith(title);
    }
    expect(boots).not.toHaveBeenCalled();
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

  const HOUR = 60 * 60_000;
  const DAY = 24 * HOUR;
  const fixture = (host: string): TlsCert => ({
    cert: readFileSync(
      join(import.meta.dir, "../http/testdata", `${host}.crt`),
      "utf8",
    ),
    key: readFileSync(
      join(import.meta.dir, "../http/testdata", `${host}.key`),
      "utf8",
    ),
  });
  const peerSubject = (port: number) =>
    new Promise<string>((resolve, reject) => {
      const socket = connect(
        { host: "127.0.0.1", port, rejectUnauthorized: false },
        () => {
          resolve(socket.getPeerCertificate().subject.CN as string);
          socket.end();
        },
      );
      socket.on("error", reject);
    });

  test("serve --https uses the issuer, prints the https banner and renews on the timer", async () => {
    const example = fixture("example.test");
    const validTo = Date.parse(
      new (await import("node:crypto")).X509Certificate(example.cert).validTo,
    );
    const clock = fakeClock(
      new Date(validTo - 30 * DAY - 60 * 60_000).toISOString(),
    );
    const issued: TlsCert[] = [example, fixture("other.test")];
    const calls: string[][] = [];
    const rescheduled = Promise.withResolvers<void>();
    const timers: Timers = {
      ...clock.timers,
      setTimeout: (fn, ms) => {
        if (ms === 12 * HOUR && calls.length === 2) rescheduled.resolve();
        return clock.timers.setTimeout(fn, ms);
      },
    };
    const listen = spyOn(Bun, "serve");
    const cli = testApp({
      now: clock.now,
      timers,
      certIssuer: {
        issue: async (hosts) => {
          calls.push(hosts);
          return issued[calls.length - 1]!;
        },
      },
      argv: [
        "serve",
        "--http",
        "127.0.0.1:0",
        "--https",
        "127.0.0.1:0",
        "example.test",
      ],
    });
    const started = Promise.withResolvers<void>();
    spyOn(console, "log").mockImplementation((line: string) => {
      out.push(String(line));
      if (String(line).startsWith("Server started")) started.resolve();
    });
    const done = cli.start();
    await started.promise;
    expect(out[0]).toBe("Server started at https://example.test");
    expect(calls).toEqual([["example.test", "www.example.test"]]);
    // the redirect listener starts first, the https one after the certificate
    const [httpPort, httpsPort] = listen.mock.results.map(
      (r) => (r.value as Bun.Server<unknown>).port!,
    );
    expect(await peerSubject(httpsPort!)).toBe("example.test");
    const redirect = await fetch(`http://127.0.0.1:${httpPort}/a`, {
      redirect: "manual",
    });
    expect(redirect.headers.get("location")).toBe("https://127.0.0.1/a");

    // shutdown timeout of the swapped listener, then the next 12 h check
    clock.advance(12 * HOUR);
    await rescheduled.promise;
    expect(calls).toHaveLength(2);
    expect(await peerSubject(httpsPort!)).toBe("other.test");

    process.emit("SIGINT");
    expect(await done).toBe(0);
    const down = (url: string) =>
      fetch(url, { tls: { rejectUnauthorized: false } }).then(
        () => "up",
        () => "down",
      );
    expect(await down(`https://127.0.0.1:${httpsPort}/api/health`)).toBe(
      "down",
    );
    expect(await down(`http://127.0.0.1:${httpPort}/`)).toBe("down");
    clock.advance(24 * HOUR);
    expect(calls).toHaveLength(2);
  });

  test("serve with domains defaults the listeners like PB", () => {
    expect(serveAddrs([])).toEqual({ http: "127.0.0.1:8090" });
    expect(serveAddrs([], undefined, "127.0.0.1:8443")).toEqual({
      http: "127.0.0.1:8090",
      https: "127.0.0.1:8443",
    });
    expect(serveAddrs(["example.test"])).toEqual({
      http: "0.0.0.0:80",
      https: "0.0.0.0:443",
    });
    expect(serveAddrs(["example.test"], "127.0.0.1:81", ":8443")).toEqual({
      http: "127.0.0.1:81",
      https: ":8443",
    });
  });
});

describe("import", () => {
  test("import prints the summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "heybe-import-cmd-"));
    try {
      const pbDir = join(dir, "pb_data");
      writePbDataDir(pbDir, {
        rows: {
          users: [{ id: "user00000000001", email: "a@example.com" }],
        },
        files: { "_pb_users_auth_/user00000000001/a.txt": "a" },
      });
      const cli = testApp({ argv: ["import", pbDir] });
      expect(await cli.start()).toBe(0);
      expect(out.at(-1)).toBe(
        `Imported 6 collections, 1 records and 1 files from ${pbDir}.`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("import without a path fails with exit 1", async () => {
    expect(await testApp({ argv: ["import"] }).start()).toBe(1);
    expect(err.at(-1)).toBe("Error: Missing pb_data path argument.");
  });

  test("import with an empty --encryptionEnv variable names it", async () => {
    const cli = testApp({
      argv: ["import", "pb_data", "--encryptionEnv", "HEYBE_TEST_UNSET_KEY"],
    });
    expect(await cli.start()).toBe(1);
    expect(err.at(-1)).toBe(
      'Error: the --encryptionEnv variable "HEYBE_TEST_UNSET_KEY" is not set or empty',
    );
  });

  test("import --help", async () => {
    expect(await testApp({ argv: ["import", "--help"] }).start()).toBe(0);
    const text = stdout.join("");
    expect(text).toContain("Usage:\n  heybe import <pb_data> [flags]\n");
    expect(text).toContain("      --encryptionEnv string   the env variable");
    stdout.length = 0;
    expect(await testApp({ argv: [] }).start()).toBe(0);
    expect(stdout.join("")).toContain("  import      Imports a PocketBase");
  });
});
