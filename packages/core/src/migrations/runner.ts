import type { App } from "../app";
import type { MigrationDef } from "./migration";

export interface Io {
  out(line: string): void;
  confirm(question: string): Promise<boolean>;
}

const TABLE = "_migrations";

export function createMigrationsTable(app: App): void {
  app.db.run(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (file VARCHAR(255) PRIMARY KEY NOT NULL, applied INTEGER NOT NULL)`,
  );
}

async function wrapped(message: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    throw new Error(
      `${message}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

// Port of PB core/migrations_runner.go
export class MigrationsRunner {
  private inited = false;

  constructor(
    private readonly app: App,
    private readonly list: MigrationDef[],
  ) {}

  async run(args: string[], io: Io): Promise<void> {
    await this.init();
    const cmd = args[0] ?? "up";
    switch (cmd) {
      case "up": {
        const applied = await this.up();
        if (applied.length === 0) io.out("No new migrations to apply.");
        for (const file of applied) io.out(`Applied ${file}`);
        return;
      }
      case "down": {
        let count = 1;
        if (args.length > 1) {
          count = /^[+-]?\d+$/.test(args[1]!)
            ? Number.parseInt(args[1]!, 10)
            : 0;
          if (count < 0) count = this.list.length;
        }
        const names = this.lastApplied(count);
        const confirmed = await io.confirm(
          `\n${names.join("\n")}\nDo you really want to revert the last ${count} applied migration(s)?`,
        );
        if (!confirmed) {
          io.out("The command has been cancelled");
          return;
        }
        const reverted = await this.down(count);
        if (reverted.length === 0) io.out("No migrations to revert.");
        for (const file of reverted) io.out(`Reverted ${file}`);
        return;
      }
      case "history-sync":
        await this.historySync();
        io.out(`The ${TABLE} table was synced with the available migrations.`);
        return;
      default:
        throw new Error(`unsupported command: ${JSON.stringify(cmd)}`);
    }
  }

  async up(): Promise<string[]> {
    await this.init();
    const { app } = this;
    return app.db.write(async () => {
      const applied: string[] = [];
      for (const m of this.list) {
        if (
          app.db.get(`SELECT 1 AS x FROM ${TABLE} WHERE file = ? LIMIT 1`, [
            m.file,
          ])
        )
          continue;
        if (m.up)
          await wrapped(`failed to apply migration ${m.file}`, () =>
            m.up!(app),
          );
        await wrapped(
          `failed to save applied migration info for ${m.file}`,
          () =>
            app.db.run(`INSERT INTO ${TABLE} (file, applied) VALUES (?, ?)`, [
              m.file,
              app.now().getTime() * 1000,
            ]),
        );
        applied.push(m.file);
      }
      return applied;
    });
  }

  async down(count: number): Promise<string[]> {
    await this.init();
    const { app } = this;
    const names = this.lastApplied(count);
    return app.db.write(async () => {
      const reverted: string[] = [];
      for (const name of names) {
        const m = this.list.find((m) => m.file === name)!;
        if (m.down)
          await wrapped(`failed to revert migration ${m.file}`, () =>
            m.down!(app),
          );
        await wrapped(
          `failed to save reverted migration info for ${m.file}`,
          () => app.db.run(`DELETE FROM ${TABLE} WHERE file = ?`, [m.file]),
        );
        reverted.push(m.file);
      }
      return reverted;
    });
  }

  async historySync(): Promise<void> {
    await this.init();
    await this.app.db.write(() =>
      this.app.db.run(
        `DELETE FROM ${TABLE} WHERE file NOT IN (SELECT value FROM json_each(?))`,
        [this.files()],
      ),
    );
  }

  private async init(): Promise<void> {
    if (this.inited) return;
    await this.app.db.write(() => createMigrationsTable(this.app));
    this.inited = true;
  }

  private files(): string {
    return JSON.stringify(this.list.map((m) => m.file));
  }

  // microsecond and second timestamps unified like PB
  private lastApplied(limit: number): string[] {
    return this.app.db
      .query<{ file: string }>(
        `SELECT file FROM ${TABLE} WHERE applied IS NOT NULL AND file IN (SELECT value FROM json_each(?)) ORDER BY substr(applied||'0000000000000000', 0, 17) DESC, file DESC LIMIT ?`,
        [this.files(), limit],
      )
      .map((r) => r.file);
  }
}
