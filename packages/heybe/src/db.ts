import { Database, type SQLQueryBindings } from "bun:sqlite";

export interface Db {
  query<T>(sql: string, params?: unknown[]): T[];
  get<T>(sql: string, params?: unknown[]): T | null;
  run(sql: string, params?: unknown[]): { changes: number };
  tx<T>(fn: () => T): T;
  close(): void;
}

export function openDb(path: string): Db {
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA busy_timeout = 10000");
  sqlite.run("PRAGMA foreign_keys = ON");
  sqlite.run("PRAGMA synchronous = NORMAL");

  const cache = new Map<string, ReturnType<Database["query"]>>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) {
      s = sqlite.query(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const bind = (params?: unknown[]) => (params ?? []) as SQLQueryBindings[];

  let depth = 0;

  return {
    query: <T>(sql: string, params?: unknown[]) =>
      stmt(sql).all(...bind(params)) as T[],
    get: <T>(sql: string, params?: unknown[]) =>
      (stmt(sql).get(...bind(params)) as T | null) ?? null,
    run: (sql, params) => ({ changes: stmt(sql).run(...bind(params)).changes }),
    tx<T>(fn: () => T): T {
      const outer = depth === 0;
      const savepoint = `sp_${depth}`;
      sqlite.run(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
      depth++;
      try {
        const result = fn();
        sqlite.run(outer ? "COMMIT" : `RELEASE ${savepoint}`);
        return result;
      } catch (e) {
        if (outer) sqlite.run("ROLLBACK");
        else {
          sqlite.run(`ROLLBACK TO ${savepoint}`);
          sqlite.run(`RELEASE ${savepoint}`);
        }
        throw e;
      } finally {
        depth--;
      }
    },
    close: () => sqlite.close(),
  };
}
