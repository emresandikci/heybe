import type { App } from "../app";
import { writeTypes } from "../typegen";
import { parseCommandArgs } from "./args";
import type { CommandHelp } from "./help";
import { DEFAULT_TYPES_FILE } from "./serve";

export const typegenHelp: CommandHelp = {
  use: "typegen",
  description: "Generates TypeScript types for the collections",
  flags: [
    {
      name: "out",
      type: "string",
      usage: "the file to write the types to",
      default: `"${DEFAULT_TYPES_FILE}"`,
    },
  ],
};

export function typegenCommand(args: string[], app: App): void {
  const { values } = parseCommandArgs(args, { out: { type: "string" } });
  writeTypes(
    app,
    typeof values.out === "string" ? values.out : DEFAULT_TYPES_FILE,
  );
}
