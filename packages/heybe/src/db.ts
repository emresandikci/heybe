import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";

export interface Db {
  query<T>(sql: string, params?: unknown[]): T[];
  get<T>(sql: string, params?: unknown[]): T | null;
  run(sql: string, params?: unknown[]): { changes: number };
  tx<T>(fn: () => T): T;
  cacheSize(): number;
  close(): void;
}

const CACHE_LIMIT = 200;
const UNCACHED = /^\s*(CREATE|DROP|ALTER|PRAGMA)\b/i;

export function openDb(path: string): Db {
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA busy_timeout = 10000");
  sqlite.run("PRAGMA foreign_keys = ON");
  sqlite.run("PRAGMA synchronous = NORMAL");

  const cache = new Map<string, Statement>();
  const withStmt = <R>(sql: string, fn: (s: Statement) => R): R => {
    if (UNCACHED.test(sql)) {
      const s = sqlite.prepare(sql);
      try {
        return fn(s);
      } finally {
        s.finalize();
      }
    }
    let s = cache.get(sql);
    if (s) cache.delete(sql);
    else {
      s = sqlite.prepare(sql);
      if (cache.size >= CACHE_LIMIT) {
        const [oldest, evicted] = cache.entries().next().value!;
        cache.delete(oldest);
        evicted.finalize();
      }
    }
    cache.set(sql, s);
    return fn(s);
  };
  const bind = (params?: unknown[]) => (params ?? []) as SQLQueryBindings[];

  let depth = 0;

  return {
    query: <T>(sql: string, params?: unknown[]) =>
      withStmt(sql, (s) => s.all(...bind(params)) as T[]),
    get: <T>(sql: string, params?: unknown[]) =>
      withStmt(sql, (s) => (s.get(...bind(params)) as T | null) ?? null),
    run: (sql, params) =>
      withStmt(sql, (s) => ({ changes: s.run(...bind(params)).changes })),
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
    cacheSize: () => cache.size,
    close: () => {
      for (const s of cache.values()) s.finalize();
      cache.clear();
      sqlite.close();
    },
  };
}
