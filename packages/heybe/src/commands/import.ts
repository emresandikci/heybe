import { resolve } from "node:path";
import type { App } from "../app";
import { importPocketBase } from "../import/pocketbase";
import { parseCommandArgs } from "./args";
import type { CommandHelp } from "./help";

export const importHelp: CommandHelp = {
  use: "import <pb_data>",
  description: "Imports a PocketBase data directory into a fresh Heybe one",
  flags: [
    {
      name: "encryptionEnv",
      type: "string",
      usage:
        "the env variable whose value of 32 characters was used as encryption key for the PocketBase settings",
    },
  ],
};

export async function importCommand(args: string[], app: App): Promise<void> {
  const { values, positionals } = parseCommandArgs(args, {
    encryptionEnv: { type: "string" },
  });
  const dir = positionals[0];
  if (!dir) throw new Error("Missing pb_data path argument.");
  const env =
    typeof values.encryptionEnv === "string" ? values.encryptionEnv : "";
  const encryptionKey = env ? process.env[env] : undefined;
  if (env && !encryptionKey)
    throw new Error(
      `the --encryptionEnv variable "${env}" is not set or empty`,
    );
  const summary = await importPocketBase(app, resolve(dir), { encryptionKey });
  console.log(
    `Imported ${summary.collections} collections, ${summary.records} records and ${summary.files} files from ${dir}.`,
  );
}
