import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { App } from "../app";
import { Migration, type MigrationDef, migrationDef } from "./migration";

function toDef(file: string, exported: unknown): MigrationDef | null {
  if (exported === undefined) return null;
  if (typeof exported === "function" && exported.prototype instanceof Migration)
    return migrationDef(file, new (exported as new () => Migration)());
  if (exported && typeof exported === "object") {
    const { up, down } = exported as Omit<MigrationDef, "file">;
    return { file, up, down };
  }
  throw new Error(
    `invalid migration ${file}: the default export must be migrate(...) or a Migration subclass`,
  );
}

export async function loadMigrations(dir: string): Promise<MigrationDef[]> {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => /\.(ts|js)$/.test(f) && statSync(resolve(dir, f)).isFile())
    .sort();
  const list: MigrationDef[] = [];
  for (const file of files) {
    let exported: unknown;
    try {
      exported = (await import(resolve(dir, file))).default;
    } catch (err) {
      throw new Error(
        `failed to run migration ${file}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    const def = toDef(file, exported);
    if (def) list.push(def);
  }
  return list;
}

// code-registered migrations plus the migrations dir files, sorted by file like PB MigrationsList
export async function migrationsList(app: App): Promise<MigrationDef[]> {
  return [...app.migrations, ...(await loadMigrations(app.migrationsDir))].sort(
    (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
  );
}
