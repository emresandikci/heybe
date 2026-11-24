import { AsyncLocalStorage } from "node:async_hooks";
import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import type { Timers } from "./timers";

export interface Db {
  query<T>(sql: string, params?: unknown[]): T[];
  get<T>(sql: string, params?: unknown[]): T | null;
  run(sql: string, params?: unknown[]): { changes: number };
  tx<T>(fn: () => T): T;
  write<T>(fn: () => T | Promise<T>): Promise<T>;
  onComplete(fn: (err: unknown) => unknown): void;
  committed<T>(fn: () => T): T;
  // changes when a write that may have touched _collections ends, and after exclusive or reopen
  collectionsVersion(): number;
  inWrite(): boolean;
  close(): void;
}

const CACHE_LIMIT = 200;
const UNCACHED = /^\s*(CREATE|DROP|ALTER|PRAGMA)\b/i;
const SELECT = /^\s*SELECT\b/i;
const OUTSIDE_WRITE =
  "heybe: db write outside db.write while a write transaction is open";
const RUN_OUTSIDE_WRITE =
  "heybe: db.run must be called inside db.write (or db.tx)";

// One per write. onComplete callbacks move to the parent when the write ends; the outermost runs them.
interface Context {
  parent: Context | null;
  open: boolean;
  complete: ((err: unknown) => unknown)[];
  // nested writes started in this context: serialized, and awaited before it ends
  lock: Lock;
  pending: Set<Promise<unknown>>;
}

interface Lock {
  locked(): boolean;
  acquire(): Promise<void>;
  release(): void;
}

function fifoLock(): Lock {
  const waiting: (() => void)[] = [];
  let locked = false;
  return {
    locked: () => locked,
    acquire: () => {
      if (!locked) {
        locked = true;
        return Promise.resolve();
      }
      return new Promise((resolve) => waiting.push(resolve));
    },
    release: () => {
      const next = waiting.shift();
      if (next) next();
      else locked = false;
    },
  };
}

function openSqlite(path: string, busyTimeoutMs: number): Database {
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  sqlite.run("PRAGMA foreign_keys = ON");
  sqlite.run("PRAGMA synchronous = NORMAL");
  // macOS system SQLite defaults to legacy mode, where renames skip views and dropping a column a view reads is allowed
  sqlite.run("PRAGMA legacy_alter_table = OFF");
  return sqlite;
}

// A short-lived connection to the same file with the same pragmas, for SQL that may leave
// connection state behind (an open BEGIN, PRAGMA query_only). The caller closes it.
export function openSibling(sqlite: Database): Database {
  const { timeout } = sqlite
    .query<{ timeout: number }, []>("PRAGMA busy_timeout")
    .get()!;
  return openSqlite(sqlite.filename, timeout);
}

function connection(path: string, readonly: boolean, busyTimeoutMs: number) {
  const sqlite = openSqlite(path, busyTimeoutMs);
  if (readonly) sqlite.run("PRAGMA query_only = ON");

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
  const close = () => {
    for (const s of cache.values()) s.finalize();
    cache.clear();
    sqlite.close();
  };
  return { sqlite, cache, withStmt, close };
}

// picked by A/B on the create benchmark: under sustained writes a 1 s tick lets the WAL reach the
// writer's autocheckpoint, which then runs inside a request
const CHECKPOINT_DELAY_MS = 250;
const CHECKPOINT_COMMITS = 200;
const WAL_AUTOCHECKPOINT_PAGES = 10_000;
// the -wal file shrinks back to this after a burst, instead of keeping its high-water size
const WAL_SIZE_LIMIT_BYTES = 16 * 1024 * 1024;
const WORKER_TIMEOUT_MS = 5000;

interface Checkpointer {
  written(): void;
  pause(): Promise<void>;
  resume(): void;
  stop(): void;
  connected(): boolean;
  running(): boolean;
  // resolves when no message to the worker is in flight
  idle(): Promise<void>;
}

// PASSIVE checkpoints in a worker thread with its own connection, so a commit never runs one.
// A tick is scheduled only after a write; pause closes the worker's connection.
function checkpointer(path: string, timers: Timers): Checkpointer {
  type CheckpointWorker = Worker & { ref(): void; unref(): void };
  let worker: CheckpointWorker | null = null;
  let timer: unknown = null;
  let dirty = false;
  let paused = false;
  let stopped = false;
  let connected = false;
  let inflight: Promise<unknown> = Promise.resolve();
  let lastId = 0;
  let commits = 0;
  let ticking = false;
  type Reply = { complete?: boolean; error?: string };
  const replies = new Map<number, (data: Reply) => void>();

  // a dead or stuck worker answers whatever was waiting, so pause never hangs
  const exited = (w: CheckpointWorker, error: string) => {
    if (worker === w) {
      worker = null;
      connected = false;
    }
    w.terminate();
    for (const reply of replies.values()) reply({ error });
    replies.clear();
  };

  const start = () => {
    const w = new Worker(
      new URL("./checkpoint-worker.ts", import.meta.url),
    ) as CheckpointWorker;
    w.unref();
    w.onmessage = (e: MessageEvent<Reply & { id: number }>) => {
      const reply = replies.get(e.data.id);
      replies.delete(e.data.id);
      if (replies.size === 0) w.unref();
      reply?.(e.data);
    };
    w.onerror = (e) => exited(w, e.message);
    w.addEventListener("close", () => exited(w, "checkpoint worker exited"));
    return w;
  };

  const post = (w: CheckpointWorker, close: boolean) => {
    const id = ++lastId;
    const done = new Promise<Reply>((resolve) => replies.set(id, resolve));
    w.ref();
    w.postMessage({ id, path, close });
    inflight = Promise.all([inflight, done]);
    return done;
  };

  const schedule = () => {
    if (timer === null && dirty && !paused && !stopped)
      timer = timers.setTimeout(tick, CHECKPOINT_DELAY_MS);
  };

  const tick = async () => {
    timer = null;
    if (paused || stopped) return;
    dirty = false;
    commits = 0;
    ticking = true;
    worker ??= start();
    const { complete, error } = await post(worker, false);
    ticking = false;
    connected = error === undefined && !stopped;
    // frames a reader still needed stay in the WAL, so try again; after an error the next write retries
    if (error === undefined && !complete) dirty = true;
    schedule();
  };

  return {
    written: () => {
      dirty = true;
      if (++commits >= CHECKPOINT_COMMITS && !ticking) {
        if (timer !== null) timers.clearTimeout(timer);
        timer = null;
        void tick();
      } else schedule();
    },
    pause: async () => {
      paused = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      const w = worker;
      const guard = timers.setTimeout(() => {
        if (w) exited(w, "checkpoint worker did not answer");
      }, WORKER_TIMEOUT_MS);
      try {
        await inflight;
        if (worker) await post(worker, true);
      } finally {
        timers.clearTimeout(guard);
      }
      connected = false;
    },
    resume: () => {
      paused = false;
      schedule();
    },
    // synchronous, so the db files are free when close returns: the worker closes its connection
    // after any checkpoint in flight and signals through shared memory
    stop: () => {
      stopped = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      const w = worker;
      if (!w) return;
      const signal = new Int32Array(new SharedArrayBuffer(4));
      w.postMessage({ id: ++lastId, path, close: true, signal });
      Atomics.wait(signal, 0, 0, WORKER_TIMEOUT_MS);
      exited(w, "checkpoint worker stopped");
    },
    connected: () => connected,
    running: () => worker !== null,
    idle: async () => {
      let seen;
      do {
        seen = inflight;
        await seen;
      } while (seen !== inflight);
    },
  };
}

const checkpointers = new WeakMap<Db, Checkpointer>();

export const checkpointerOf = (db: Db): Checkpointer | undefined =>
  checkpointers.get(db);

const cacheSizes = new WeakMap<Db, () => number>();

export const statementCacheSize = (db: Db): number => cacheSizes.get(db)!();

const exclusives = new WeakMap<
  Db,
  (fn: (sqlite: Database) => unknown) => Promise<unknown>
>();

// For statements that cannot run in a transaction, like VACUUM: waits for the write mutex and
// hands over the writer's raw handle, no transaction is opened. An async fn holds the mutex until it settles.
export const exclusive = <T>(
  db: Db,
  fn: (sqlite: Database) => T,
): Promise<Awaited<T>> => exclusives.get(db)!(fn) as Promise<Awaited<T>>;

const reopens = new WeakMap<Db, () => void>();

// Opens the connections again, for db files that were renamed while open: macOS system SQLite fails
// every later call on such a connection, even after the file is moved back. Call it holding `exclusive`.
export const reopen = (db: Db): void => reopens.get(db)!();

// One writer connection behind a FIFO mutex and a query_only reader connection. Inside `write`
// (tracked with AsyncLocalStorage) every query goes to the writer; elsewhere reads see only
// committed data. With `checkpointTimers`, WAL checkpoints run in a worker instead of on commit.
export function openDb(
  path: string,
  busyTimeoutMs = 10_000,
  checkpointTimers?: Timers,
): Db {
  const cp = checkpointTimers ? checkpointer(path, checkpointTimers) : null;
  const openWriter = () => {
    const c = connection(path, false, busyTimeoutMs);
    if (cp) {
      c.sqlite.run(`PRAGMA wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
      c.sqlite.run(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
    }
    return c;
  };
  let writer = openWriter();
  let reader = connection(path, true, busyTimeoutMs);
  const mutex = fifoLock();
  const als = new AsyncLocalStorage<Context>();
  let syncDepth = 0;
  let savepoints = 0;
  let version = 0;
  let collectionsTouched = false;

  // a write that ended hands its late callers to the nearest open ancestor
  const active = () => {
    let ctx = als.getStore() ?? null;
    while (ctx && !ctx.open) ctx = ctx.parent;
    return ctx;
  };
  const onWriter = () => active() !== null || syncDepth > 0;
  const bind = (params?: unknown[]) => (params ?? []) as SQLQueryBindings[];
  const onWriterTracked = (sql: string) => {
    if (!onWriter()) return false;
    if (!collectionsTouched && /_collections/i.test(sql) && !SELECT.test(sql))
      collectionsTouched = true;
    return true;
  };
  // called when a root transaction ends, committed or rolled back
  const endRoot = () => {
    if (collectionsTouched) version++;
    collectionsTouched = false;
    cp?.written();
  };
  const exec = (sql: string) => writer.sqlite.run(sql);

  const newContext = (parent: Context | null): Context => ({
    parent,
    open: true,
    complete: [],
    lock: fifoLock(),
    pending: new Set(),
  });

  // closes in the same synchronous step that sees nothing pending, so a later write goes elsewhere
  const drainAndClose = async (ctx: Context) => {
    while (ctx.pending.size > 0) await Promise.allSettled([...ctx.pending]);
    ctx.open = false;
  };

  const runIn = <T>(ctx: Context, fn: () => T | Promise<T>): Promise<T> =>
    als.run(ctx, async () => {
      try {
        return await fn();
      } finally {
        await drainAndClose(ctx);
      }
    });

  const inSavepoint = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    const name = `sp_${++savepoints}`;
    exec(`SAVEPOINT ${name}`);
    try {
      const result = await fn();
      exec(`RELEASE ${name}`);
      return result;
    } catch (e) {
      exec(`ROLLBACK TO ${name}`);
      exec(`RELEASE ${name}`);
      throw e;
    }
  };

  const nested = <T>(parent: Context, fn: () => T | Promise<T>): Promise<T> => {
    const p = (async () => {
      await parent.lock.acquire();
      const ctx = newContext(parent);
      try {
        const result = await inSavepoint(() => runIn(ctx, fn));
        parent.complete.push(...ctx.complete);
        return result;
      } catch (e) {
        // a rolled back savepoint completes with its own error whatever its parents do
        parent.complete.push(...ctx.complete.map((cb) => () => cb(e)));
        throw e;
      } finally {
        parent.lock.release();
      }
    })();
    parent.pending.add(p);
    const done = () => parent.pending.delete(p);
    p.then(done, done);
    return p;
  };

  const write = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    const parent = active();
    if (parent) return nested(parent, fn);

    await mutex.acquire();
    const root = newContext(null);
    let result: T;
    let error: unknown = null;
    try {
      exec("BEGIN IMMEDIATE");
    } catch (e) {
      root.open = false;
      mutex.release();
      throw e;
    }
    try {
      result = await runIn(root, fn);
      exec("COMMIT");
    } catch (e) {
      error = e;
      if (writer.sqlite.inTransaction) exec("ROLLBACK");
    } finally {
      endRoot();
      root.open = false;
      mutex.release();
    }
    // like PB, every callback runs and their errors are joined with the transaction's
    const errors: unknown[] = error === null ? [] : [error];
    for (const cb of root.complete) {
      try {
        await als.exit(() => cb(error));
      } catch (e) {
        errors.push(e);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, errors.map(String).join("; "));
    return result!;
  };

  const db: Db = {
    query: <T>(sql: string, params?: unknown[]) =>
      (onWriterTracked(sql) ? writer : reader).withStmt(
        sql,
        (s) => s.all(...bind(params)) as T[],
      ),
    get: <T>(sql: string, params?: unknown[]) =>
      (onWriterTracked(sql) ? writer : reader).withStmt(
        sql,
        (s) => (s.get(...bind(params)) as T | null) ?? null,
      ),
    run: (sql, params) => {
      if (!onWriterTracked(sql)) throw new Error(RUN_OUTSIDE_WRITE);
      return writer.withStmt(sql, (s) => ({
        changes: s.run(...bind(params)).changes,
      }));
    },
    tx<T>(fn: () => T): T {
      const inside = onWriter();
      if (!inside && mutex.locked()) throw new Error(OUTSIDE_WRITE);
      const name = inside ? `sp_${++savepoints}` : null;
      exec(name ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
      syncDepth++;
      try {
        const result = fn();
        exec(name ? `RELEASE ${name}` : "COMMIT");
        return result;
      } catch (e) {
        if (name) {
          exec(`ROLLBACK TO ${name}`);
          exec(`RELEASE ${name}`);
        } else if (writer.sqlite.inTransaction) exec("ROLLBACK");
        throw e;
      } finally {
        syncDepth--;
        if (!name) endRoot();
      }
    },
    write,
    onComplete: (fn) => {
      const ctx = active();
      if (ctx) ctx.complete.push(fn);
      else fn(null);
    },
    committed: <T>(fn: () => T) => {
      const depth = syncDepth;
      syncDepth = 0;
      try {
        return als.exit(fn);
      } finally {
        syncDepth = depth;
      }
    },
    collectionsVersion: () => version,
    inWrite: onWriter,
    close: () => {
      reader.close();
      if (cp) {
        cp.stop();
        // best effort: a restore may have moved the files under the connection
        try {
          writer.sqlite.run("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch {}
      }
      writer.close();
    },
  };
  cacheSizes.set(db, () => writer.cache.size + reader.cache.size);
  if (cp) checkpointers.set(db, cp);
  reopens.set(db, () => {
    reader.close();
    writer.close();
    writer = openWriter();
    reader = connection(path, true, busyTimeoutMs);
    version++;
  });
  exclusives.set(db, async (fn) => {
    if (onWriter()) throw new Error("heybe: exclusive inside db.write");
    await mutex.acquire();
    try {
      await cp?.pause();
      return await fn(writer.sqlite);
    } finally {
      version++;
      cp?.written();
      cp?.resume();
      mutex.release();
    }
  });
  return db;
}
