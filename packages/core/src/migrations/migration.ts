import type { App } from "../app";

export interface MigrationDef {
  file: string;
  up?: (app: App) => unknown;
  down?: (app: App) => unknown;
}

export function migrate(
  up?: (app: App) => unknown,
  down?: (app: App) => unknown,
): { up?: (app: App) => unknown; down?: (app: App) => unknown } {
  return { up, down };
}

// Class style: `export default class extends Migration` in a migrations dir file, or `app.register`
// with `file` set.
export abstract class Migration {
  file?: string;
  up?(app: App): unknown;
  down?(app: App): unknown;
}

export function migrationDef(file: string, m: Migration): MigrationDef {
  return {
    file,
    up: m.up && ((app) => m.up!(app)),
    down: m.down && ((app) => m.down!(app)),
  };
}
