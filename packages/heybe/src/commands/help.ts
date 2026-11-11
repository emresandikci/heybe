export interface FlagHelp {
  name: string;
  short?: string;
  type?: "string" | "strings" | "int";
  usage: string;
  default?: string;
}

export interface CommandHelp {
  use: string;
  description: string;
  long?: string;
  example?: string;
  flags?: FlagHelp[];
  commands?: CommandHelp[];
}

export const GLOBAL_FLAG_HELP: FlagHelp[] = [
  {
    name: "automigrate",
    usage: "enable/disable auto migrations",
    default: "true",
  },
  {
    name: "dev",
    usage:
      "enable dev mode, aka. printing logs and sql statements to the console",
  },
  {
    name: "dir",
    type: "string",
    usage: "the Heybe data directory",
    default: '"./heybe_data"',
  },
  {
    name: "migrationsDir",
    type: "string",
    usage: "the directory with the user defined migrations",
  },
];

const commandName = (cmd: CommandHelp) => cmd.use.split(" ")[0]!;

function flagRows(flags: FlagHelp[]): string {
  const rows = [...flags]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((f) => {
      const names = `${f.short ? `-${f.short}, ` : "    "}--${f.name}${f.type ? ` ${f.type}` : ""}`;
      return { names, flag: f };
    });
  const width = Math.max(...rows.map((r) => r.names.length));
  return rows
    .map(({ names, flag }) => {
      const [first = "", ...rest] = flag.usage.split("\n");
      const suffix =
        flag.default !== undefined ? ` (default ${flag.default})` : "";
      const lines = [first, ...rest];
      lines[lines.length - 1] += suffix;
      const pad = " ".repeat(2 + width + 3);
      return [
        `  ${names.padEnd(width)}   ${lines[0]}`,
        ...lines.slice(1).map((l) => pad + l),
      ].join("\n");
    })
    .join("\n");
}

function commandRows(commands: CommandHelp[]): string {
  return [...commands]
    .sort((a, b) => (commandName(a) < commandName(b) ? -1 : 1))
    .map((c) => `  ${commandName(c).padEnd(11)} ${c.description}`)
    .join("\n");
}

function render(
  head: string,
  usage: string,
  cmd: Pick<CommandHelp, "example" | "commands">,
  flags: FlagHelp[],
  globals: boolean,
  closing: string,
): string {
  const sections = [head, `Usage:\n  ${usage}`];
  if (cmd.example) sections.push(`Examples:\n${cmd.example}`);
  if (cmd.commands?.length)
    sections.push(`Available Commands:\n${commandRows(cmd.commands)}`);
  sections.push(`Flags:\n${flagRows(flags)}`);
  if (globals) sections.push(`Global Flags:\n${flagRows(GLOBAL_FLAG_HELP)}`);
  if (cmd.commands?.length) sections.push(closing);
  return `${sections.join("\n\n")}\n`;
}

export function formatCommandHelp(path: string[], cmd: CommandHelp): string {
  const last = path.at(-1)!;
  const args = cmd.use.split(" ").slice(1).join(" ");
  const tail = cmd.commands?.length ? "[command]" : "[flags]";
  const usage = ["heybe", ...path, args, tail].filter(Boolean).join(" ");
  return render(
    cmd.long ?? cmd.description,
    usage,
    cmd,
    [
      ...(cmd.flags ?? []),
      { name: "help", short: "h", usage: `help for ${last}` },
    ],
    true,
    `Use "heybe ${path.join(" ")} [command] --help" for more information about a command.`,
  );
}

export function formatRootHelp(commands: CommandHelp[]): string {
  return render(
    "heybe CLI",
    "heybe [command]",
    { commands },
    [
      ...GLOBAL_FLAG_HELP,
      { name: "help", short: "h", usage: "help for heybe" },
      { name: "version", short: "v", usage: "version for heybe" },
    ],
    false,
    'Use "heybe [command] --help" for more information about a command.',
  );
}

export type Route =
  | { type: "print"; text: string }
  | { type: "fail"; message: string }
  | { type: "run"; name: string; index: number };

// cobra's command lookup: before a command is known, a flag that is not a known boolean swallows
// the next argument; once a command with declared flags is known, unknown flags fail
export function routeArgv(
  argv: string[],
  commands: CommandHelp[],
  version: string,
): Route {
  const nodes: CommandHelp[] = [];
  let index = -1;
  let closed = false;
  let help = false;
  let showVersion = false;
  const fail = (message: string): Route => ({ type: "fail", message });
  const node = () => nodes.at(-1);
  const strict = () => nodes[0]?.flags !== undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = arg.slice(2, eq < 0 ? undefined : eq);
      if (name === "help") help = true;
      else if (name === "version" && !node()) showVersion = true;
      else {
        const flag = [
          ...GLOBAL_FLAG_HELP,
          ...nodes.flatMap((n) => n.flags ?? []),
        ].find((f) => f.name === name);
        if (flag) {
          if (flag.type && eq < 0) i++;
        } else if (node()) {
          if (strict()) return fail(`unknown flag: --${name}`);
        } else if (eq < 0) i++;
      }
    } else if (arg.length > 1 && arg.startsWith("-")) {
      if (arg[1] === "h") help = true;
      else if (arg[1] === "v" && !node()) showVersion = true;
      else if (node()) {
        if (strict())
          return fail(`unknown shorthand flag: '${arg[1]}' in ${arg}`);
      } else if (arg.length === 2) i++;
    } else if (!node()) {
      const command = commands.find((c) => commandName(c) === arg);
      if (!command)
        return fail(`unknown command ${JSON.stringify(arg)} for "heybe"`);
      nodes.push(command);
      index = i;
    } else if (!closed) {
      const sub = node()!.commands?.find((c) => commandName(c) === arg);
      if (sub) nodes.push(sub);
      else closed = true;
    }
  }

  const current = node();
  const path = nodes.map(commandName);
  if (help || (current?.commands?.length ?? 0) > 0)
    return {
      type: "print",
      text: current
        ? formatCommandHelp(path, current)
        : formatRootHelp(commands),
    };
  if (showVersion) return { type: "print", text: `heybe version ${version}\n` };
  if (!current) return { type: "print", text: formatRootHelp(commands) };
  return { type: "run", name: path[0]!, index };
}
