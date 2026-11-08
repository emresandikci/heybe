import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, createApp } from "../app";
import { migrateCommand } from "../commands/migrate";
import { Migration } from "./migration";
import type { Io } from "./runner";

const INDEX = JSON.stringify(join(import.meta.dir, "..", "index.ts"));
const NOW = new Date(1_700_000_000_123);
const APPLIED = 1_700_000_000_123_000;

const fnStyle = (name: string, extra = "") => `import { migrate } from ${INDEX};
export default migrate(async (app) => {
  await app.collections.save({ name: "${name}" });
  ${extra}
}, async (app) => {
  await app.collections.delete("${name}");
});
`;

const classStyle = (name: string) => `import { Migration } from ${INDEX};
export default class extends Migration {
  async up(app) { await app.collections.save({ name: "${name}" }); }
  async down(app) { await app.collections.delete("${name}"); }
}
`;

let dir: string;
let now: Date;
let app: App;
let lines: string[];
let questions: string[];
let answer: boolean;

const io: Io = {
  out: (line) => lines.push(line),
  confirm: async (q) => {
    questions.push(q);
    return answer;
  },
};

const migrate = (...args: string[]) => migrateCommand(args, app, io);
const failure = (...args: string[]) =>
  migrate(...args).then(
    () => "",
    (e: Error) => e.message,
  );
const write = (file: string, content: string) =>
  writeFileSync(join(dir, file), content);
const rows = () =>
  app.db.query<{ file: string; applied: number }>(
    "SELECT file, applied FROM _migrations ORDER BY file",
  );
const has = (name: string) => app.collections.find(name) !== null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "heybe-migrations-"));
  now = NOW;
  app = createApp({
    dir: ":memory:",
    migrationsDir: dir,
    now: () => now,
    argv: [],
  });
  lines = [];
  questions = [];
  answer = true;
});

afterEach(() => {
  app.close();
  rmSync(dir, { recursive: true, force: true });
  mock.restore();
});

describe("migrate up", () => {
  test("applies file and code migrations of both styles in file order", async () => {
    write("2_b.js", classStyle("b"));
    write("1_a.ts", fnStyle("a"));
    class Code extends Migration {
      file = "1_code";
      async up(a: App) {
        expect(a.collections.find("a")).not.toBeNull();
        await a.collections.save({ name: "code" });
      }
    }
    app.register(Code);

    await migrate("up");
    expect(lines).toEqual([
      "Applied 1_a.ts",
      "Applied 1_code",
      "Applied 2_b.js",
    ]);
    expect(rows()).toEqual([
      { file: "1_a.ts", applied: APPLIED },
      { file: "1_code", applied: APPLIED },
      { file: "2_b.js", applied: APPLIED },
    ]);
    expect(has("a") && has("b") && has("code")).toBe(true);

    lines = [];
    await migrate();
    expect(lines).toEqual(["No new migrations to apply."]);
  });

  test("a failing migration rolls back the whole run", async () => {
    write("1_a.ts", fnStyle("a"));
    write("2_b.ts", fnStyle("b", 'throw new Error("boom");'));
    write("3_c.ts", fnStyle("c"));

    expect(await failure("up")).toBe("failed to apply migration 2_b.ts: boom");
    expect(has("a") || has("b") || has("c")).toBe(false);
    expect(rows()).toEqual([]);
    expect(lines).toEqual([]);
  });

  test("an invalid default export fails to load", async () => {
    write("1_a.ts", "export default 1;\n");
    expect(await failure()).toBe(
      "invalid migration 1_a.ts: the default export must be migrate(...) or a Migration subclass",
    );
  });

  test("a file that fails to load is named", async () => {
    write("1_a.ts", 'throw new Error("top");\n');
    expect(await failure()).toBe("failed to run migration 1_a.ts: top");
  });

  test("skips directories and files without a default export", async () => {
    write("1_a.ts", fnStyle("a"));
    write("0_utils.ts", "export const x = 1;\n");
    mkdirSync(join(dir, "2_dir.ts"));
    await migrate();
    expect(lines).toEqual(["Applied 1_a.ts"]);
  });

  test("serve applies pending migrations before onServe", async () => {
    write("1_a.ts", fnStyle("a"));
    const cli = createApp({
      dir: ":memory:",
      migrationsDir: dir,
      argv: ["serve", "--http", "127.0.0.1:0"],
    });
    let applied = false;
    cli.onServe((e) => {
      applied = cli.collections.find("a") !== null;
      return e.next();
    });
    const started = new Promise<void>((resolve) => {
      spyOn(console, "log").mockImplementation((line: string) => {
        if (String(line).startsWith("Server started at ")) resolve();
      });
    });
    const done = cli.start();
    await started;
    process.emit("SIGINT");
    expect(await done).toBe(0);
    expect(applied).toBe(true);
  });
});

describe("migrate down", () => {
  beforeEach(async () => {
    write("1_a.ts", fnStyle("a"));
    write("2_b.ts", fnStyle("b"));
    write("3_c.js", classStyle("c"));
    await migrate("up");
    lines = [];
  });

  test("reverts the last n applied migrations after confirming", async () => {
    await migrate("down", "2");
    expect(questions).toEqual([
      "\n3_c.js\n2_b.ts\nDo you really want to revert the last 2 applied migration(s)?",
    ]);
    expect(lines).toEqual(["Reverted 3_c.js", "Reverted 2_b.ts"]);
    expect(rows().map((r) => r.file)).toEqual(["1_a.ts"]);
    expect([has("a"), has("b"), has("c")]).toEqual([true, false, false]);
  });

  test("defaults to 1 and a negative count reverts all", async () => {
    await migrate("down");
    expect(lines).toEqual(["Reverted 3_c.js"]);
    lines = [];
    await migrate("down", "--", "-1");
    expect(questions.at(-1)).toBe(
      "\n2_b.ts\n1_a.ts\nDo you really want to revert the last 3 applied migration(s)?",
    );
    expect(lines).toEqual(["Reverted 2_b.ts", "Reverted 1_a.ts"]);
    lines = [];
    await migrate("down");
    expect(lines).toEqual(["No migrations to revert."]);
  });

  test("a negative count without -- is an unknown flag like cobra", async () => {
    expect(await failure("down", "-1")).toBe(
      "unknown shorthand flag: '1' in -1",
    );
    expect(await failure("down", "--nope")).toBe("unknown flag: --nope");
    expect(rows()).toHaveLength(3);
  });

  test("a non-integer count reverts nothing", async () => {
    await migrate("down", "abc");
    expect(questions).toEqual([
      "\n\nDo you really want to revert the last 0 applied migration(s)?",
    ]);
    expect(lines).toEqual(["No migrations to revert."]);
    lines = [];
    await migrate("down", "1e2");
    expect(lines).toEqual(["No migrations to revert."]);
  });

  test("reverts the newest applied first, legacy second rows included", async () => {
    now = new Date(NOW.getTime() + 1000);
    write("0_z.ts", fnStyle("z"));
    await migrate("up");
    write(
      "0_legacy.ts",
      `import { migrate } from ${INDEX};\nexport default migrate();\n`,
    );
    await app.db.write(() =>
      app.db.run("INSERT INTO _migrations (file, applied) VALUES (?, ?)", [
        "0_legacy.ts",
        Math.floor(NOW.getTime() / 1000) + 5,
      ]),
    );
    lines = [];
    await migrate("down", "3");
    expect(questions.at(-1)).toBe(
      "\n0_legacy.ts\n0_z.ts\n3_c.js\nDo you really want to revert the last 3 applied migration(s)?",
    );
    expect(lines).toEqual([
      "Reverted 0_legacy.ts",
      "Reverted 0_z.ts",
      "Reverted 3_c.js",
    ]);
  });

  test("cancelled", async () => {
    answer = false;
    await migrate("down");
    expect(lines).toEqual(["The command has been cancelled"]);
    expect(rows()).toHaveLength(3);
    expect(has("c")).toBe(true);
  });

  test("a failing down rolls back the whole run", async () => {
    write(
      "4_d.ts",
      `import { migrate } from ${INDEX};
export default migrate(undefined, () => { throw new Error("nope"); });
`,
    );
    await migrate("up");
    expect(await failure("down", "2")).toBe(
      "failed to revert migration 4_d.ts: nope",
    );
    expect(rows()).toHaveLength(4);
    expect(has("c")).toBe(true);
  });

  test("history-sync removes rows of missing files", async () => {
    unlinkSync(join(dir, "2_b.ts"));
    await migrate("history-sync");
    expect(lines).toEqual([
      "The _migrations table was synced with the available migrations.",
    ]);
    expect(rows().map((r) => r.file)).toEqual(["1_a.ts", "3_c.js"]);
  });

  test("unsupported command", async () => {
    expect(await failure("sideways")).toBe('unsupported command: "sideways"');
  });
});

describe("migrate create", () => {
  test("writes a blank template", async () => {
    rmSync(dir, { recursive: true });
    await migrate("create", "AddUser posts-v2");
    const file = join(dir, "1700000000_add_user_posts_v2.ts");
    expect(questions).toEqual([
      `Do you really want to create migration ${JSON.stringify(file)}?`,
    ]);
    expect(lines).toEqual([
      `Successfully created file ${JSON.stringify(file)}`,
    ]);
    expect(readFileSync(file, "utf8")).toBe(`import { migrate } from "heybe";

export default migrate(async (app) => {
  // add up queries...
}, async (app) => {
  // add down queries...
});
`);
  });

  test("cancelled and missing name", async () => {
    answer = false;
    await migrate("create", "x");
    expect(lines).toEqual(["The command has been cancelled"]);
    expect(existsSync(join(dir, "1700000000_x.ts"))).toBe(false);
    expect(await failure("create")).toBe("missing migration file name");
  });
});

test("register rejects a Migration subclass without a file", () => {
  class NoFile extends Migration {}
  expect(() => app.register(NoFile)).toThrow(
    "Migration NoFile requires a file name",
  );
});
