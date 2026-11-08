import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { App } from "../app";
import { migrationsList } from "../migrations/loader";
import { type Io, MigrationsRunner } from "../migrations/runner";
import { GLOBAL_OPTIONS, parseCommandArgs } from "./args";

const BLANK_TEMPLATE = `import { migrate } from "heybe";

export default migrate(async (app) => {
  // add up queries...
}, async (app) => {
  // add down queries...
});
`;

function readLine(prompt: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: false,
  });
  return new Promise<string>((resolve) => {
    rl.once("close", () => resolve(""));
    rl.question(prompt, resolve);
  }).finally(() => rl.close());
}

// PB osutils.YesNoPrompt with a "no" fallback
const consoleIo: Io = {
  out: (line) => console.log(line),
  confirm: async (question) => {
    for (;;) {
      const answer = (await readLine(`${question} (y/N) `))
        .trim()
        .toLowerCase();
      if (answer === "" || answer === "n" || answer === "no") return false;
      if (answer === "y" || answer === "yes") return true;
    }
  },
};

// PB inflector.Snakecase
function snakecase(s: string): string {
  return s
    .split(/[\W_]+/)
    .filter(Boolean)
    .map((w) => w.replace(/(?<=[^A-Z])[A-Z]/g, (c) => `_${c}`))
    .join("_")
    .toLowerCase();
}

async function create(app: App, args: string[], io: Io): Promise<void> {
  if (args.length < 1) throw new Error("missing migration file name");
  const file = join(
    app.migrationsDir,
    `${Math.floor(app.now().getTime() / 1000)}_${snakecase(args[0]!)}.ts`,
  );
  if (
    !(await io.confirm(
      `Do you really want to create migration ${JSON.stringify(file)}?`,
    ))
  ) {
    io.out("The command has been cancelled");
    return;
  }
  writeFileSync(file, BLANK_TEMPLATE);
  io.out(`Successfully created file ${JSON.stringify(file)}`);
}

// Port of PB plugins/migratecmd
export async function migrateCommand(
  args: string[],
  app: App,
  io: Io = consoleIo,
): Promise<void> {
  const { positionals, tokens } = parseCommandArgs(args, {});
  const unknown = tokens?.find(
    (t) => t.kind === "option" && !Object.hasOwn(GLOBAL_OPTIONS, t.name),
  );
  // cobra rejects unknown flags, so `down -1` needs `--` before the count
  if (unknown?.kind === "option")
    throw new Error(
      unknown.rawName.startsWith("--")
        ? `unknown flag: ${unknown.rawName}`
        : `unknown shorthand flag: '${unknown.name}' in ${args[unknown.index]}`,
    );
  mkdirSync(app.migrationsDir, { recursive: true });
  if (positionals[0] === "create") return create(app, positionals.slice(1), io);
  await new MigrationsRunner(app, await migrationsList(app)).run(
    positionals,
    io,
  );
}
