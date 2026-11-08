import type { App } from "../app";
import { writeTypes } from "../typegen";
import { parseCommandArgs } from "./args";
import { DEFAULT_TYPES_FILE } from "./serve";

export function typegenCommand(args: string[], app: App): void {
  const { values } = parseCommandArgs(args, { out: { type: "string" } });
  writeTypes(
    app,
    typeof values.out === "string" ? values.out : DEFAULT_TYPES_FILE,
  );
}
