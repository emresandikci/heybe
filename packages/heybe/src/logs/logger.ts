import { join } from "node:path";
import type { App } from "../app";
import { exclusive } from "../db";
import { formatDate, newId } from "../util";
import { BUSY_TIMEOUT_MS } from "./aux-db";

// Port of PB core/base.go initLogger, core/log_model.go, core/log_printer.go and tools/logger/batch_handler.go.

export const LogLevel = { debug: -4, info: 0, warn: 4, error: 8 } as const;

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  log(level: number, message: string, data?: Record<string, unknown>): void;
  flush(): Promise<void>;
  // flush, then stop the worker; the next write starts a new one
  release(): Promise<void>;
}

interface Entry {
  time: Date;
  level: number;
  message: string;
  data: Record<string, unknown>;
}

const BATCH_SIZE = 200;
const MAX_BATCHES_IN_FLIGHT = 20;
const FLUSH_DELAY_MS = 3000;
const MAX_MESSAGE_BYTES = 8000;
const DEFAULT_MAX_DATA_SIZE = 16 << 10;
const DAY_MS = 86_400_000;
const daysAgo = (app: App, days: number) =>
  formatDate(new Date(app.now().getTime() - days * DAY_MS));

// errors become their message and bigints their decimal string, like PB's serializeLogError
const replacer = (_: string, v: unknown) =>
  v instanceof Error ? v.message : typeof v === "bigint" ? v.toString() : v;

function toJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, replacer);
  } catch {
    return undefined;
  }
}

// a cut inside a multi-byte character drops that character
export function cutBytes(text: string, max: number): string {
  const buf = Buffer.from(text);
  if (buf.length <= max) return text;
  let end = max;
  while ((buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString();
}

// PB decodes the first maxSize bytes, which keeps the entries that end inside them
function exportData(data: Record<string, unknown>, maxSize: number): string {
  const raw = toJson(data);
  if (raw === undefined) return "{}";
  if (Buffer.byteLength(raw) <= maxSize) return raw;
  const kept: string[] = [];
  let end = 1;
  for (const [key, value] of Object.entries(data)) {
    const json = toJson(value);
    if (json === undefined) continue;
    const entry = `${JSON.stringify(key)}:${json}`;
    end += Buffer.byteLength(entry) + (kept.length > 0 ? 1 : 0);
    if (end > maxSize) break;
    kept.push(entry);
  }
  kept.push('"__pb_truncated__":true');
  return `{${kept.join(",")}}`;
}

export function logRow(
  app: App,
  entry: Entry,
  maxDataSize = app.settings.current().logs.maxDataSize,
): unknown[] {
  const maxSize = maxDataSize || DEFAULT_MAX_DATA_SIZE;
  return [
    newId(),
    entry.level,
    cutBytes(entry.message, MAX_MESSAGE_BYTES),
    exportData(entry.data, maxSize),
    formatDate(entry.time),
  ];
}

const color = (codes: string, text: string) =>
  process.stdout.isTTY ? `\x1b[${codes}m${text}\x1b[0m` : text;

const LABELS: Record<number, [string, string, string]> = {
  [LogLevel.debug]: ["DEBUG ", "1;90", "37"],
  [LogLevel.info]: ["INFO ", "1;37", "37"],
  [LogLevel.warn]: ["WARN ", "1;33", "33"],
  [LogLevel.error]: ["ERROR ", "1;31", "31"],
};

const show = (v: unknown) =>
  typeof v === "string" ? v : (toJson(v) ?? String(v));

function printLog(entry: Entry): void {
  const [label, labelColor, textColor] = LABELS[entry.level] ?? [
    `[${entry.level}] `,
    "1;36",
    "36",
  ];
  let out = color(labelColor, label) + color(textColor, entry.message) + "\n";
  const { data } = entry;
  if (data.type === "request") {
    let padding = "";
    for (const key of ["error", "details"]) {
      if (data[key] == null) continue;
      out += color("91", `${padding}└─ ${show(data[key])}`) + "\n";
      padding += "   ";
    }
  } else if (Object.keys(data).length > 0) {
    out += color("90", `└─ ${toJson(data) ?? "{}"}`) + "\n";
  }
  process.stdout.write(out);
}

export function createLogger(app: App): Logger & { close(): void } {
  let queue: Entry[] = [];
  let timer: unknown = null;
  let stopped = false;
  let closed = false;
  const writing = new Set<Promise<void>>();
  // Bun's Worker has ref/unref, the DOM type in scope does not
  let worker: (Worker & { ref(): void; unref(): void }) | null = null;
  let lastId = 0;
  const pending = new Map<
    number,
    { resolve: () => void; reject: (err: Error) => void }
  >();

  let warnedBehind = false;

  const stopWorker = (err = new Error("log worker stopped")) => {
    worker?.terminate();
    worker = null;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  // ref'd only while a batch is in flight, so an idle worker never keeps the process alive
  const startWorker = () => {
    const w = new Worker(
      new URL("./log-worker.ts", import.meta.url),
    ) as NonNullable<typeof worker>;
    w.unref();
    w.onmessage = (e: MessageEvent<{ id: number; error?: string }>) => {
      const p = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (pending.size === 0) w.unref();
      if (e.data.error === undefined) p?.resolve();
      else p?.reject(new Error(e.data.error));
    };
    const exited = (err: Error) => {
      if (worker === w) stopWorker(err);
    };
    w.onerror = (e) => exited(e.error ?? new Error(e.message));
    w.addEventListener("close", () => exited(new Error("log worker exited")));
    return w;
  };

  const insert = (rows: unknown[][]) =>
    new Promise<void>((resolve, reject) => {
      if (closed) throw new Error("the app is closed");
      worker ??= startWorker();
      const id = ++lastId;
      pending.set(id, { resolve, reject });
      worker.ref();
      worker.postMessage({
        id,
        path: join(app.dataDir, "auxiliary.db"),
        busyTimeoutMs: BUSY_TIMEOUT_MS,
        rows,
      });
    });

  const clearTimer = () => {
    if (timer !== null) app.timers.clearTimeout(timer);
    timer = null;
  };

  // like PB, a batch is dropped when logs are disabled or its write fails
  const write = async (entries: Entry[]) => {
    const { maxDays, maxDataSize } = app.settings.current().logs;
    if (maxDays <= 0) return;
    const rows = entries.map((entry) => logRow(app, entry, maxDataSize));
    try {
      // the aux write mutex orders batches with main-thread aux writes and keeps them out of a restore's file swap
      await exclusive(app.auxDb, () => insert(rows));
    } catch (err) {
      console.error("Failed to write log", err);
    }
  };

  const stop = () => {
    stopped = true;
    clearTimer();
  };

  const writeQueued = () => {
    clearTimer();
    if (queue.length === 0) return;
    // the worker is behind: drop the batch like a failed write
    if (writing.size >= MAX_BATCHES_IN_FLIGHT) {
      if (!warnedBehind)
        console.error(
          "Failed to write log",
          new Error("too many log batches in flight, dropping"),
        );
      warnedBehind = true;
      queue = [];
      return;
    }
    const p = write(queue);
    queue = [];
    writing.add(p);
    void p.then(() => {
      writing.delete(p);
      if (writing.size === 0) warnedBehind = false;
    });
  };

  const log = (
    level: number,
    message: string,
    data: Record<string, unknown> = {},
  ) => {
    const { logs } = app.settings.current();
    const entry = { time: app.now(), level, message, data };
    if (app.dev) printLog(entry);
    if (level < logs.minLevel || logs.maxDays <= 0) return;
    queue.push(entry);
    if (queue.length >= BATCH_SIZE) return writeQueued();
    if (stopped) return;
    clearTimer();
    timer = app.timers.setTimeout(writeQueued, FLUSH_DELAY_MS);
  };

  const logger = {
    debug: (message: string, data?: Record<string, unknown>) =>
      log(LogLevel.debug, message, data),
    info: (message: string, data?: Record<string, unknown>) =>
      log(LogLevel.info, message, data),
    warn: (message: string, data?: Record<string, unknown>) =>
      log(LogLevel.warn, message, data),
    error: (message: string, data?: Record<string, unknown>) =>
      log(LogLevel.error, message, data),
    log,
    flush: async () => {
      writeQueued();
      await Promise.all(writing);
    },
    release: async () => {
      await logger.flush();
      await exclusive(app.auxDb, () => stopWorker());
    },
    close: () => {
      closed = true;
      stop();
      stopWorker();
    },
  };

  // a failed restart bootstraps the app again
  app.onBootstrap((e) => {
    stopped = false;
    return e.next();
  });

  app.onBootstrapClear(
    async (e) => {
      await logger.release();
      stop();
      return e.next();
    },
    { id: "__pbAppLoggerFlushBeforeStop__", priority: -999 },
  );

  app.onSettingsReload(
    async (e) => {
      await e.next();
      const { maxDays, minLevel } = app.settings.get().logs;
      try {
        await app.auxDb.write(() =>
          app.auxDb.run("DELETE FROM _logs WHERE created <= ? OR level < ?", [
            daysAgo(app, maxDays),
            minLevel,
          ]),
        );
      } catch (error) {
        app.logger.debug("Failed to cleanup old logs", { error });
      }
      if (maxDays !== 0) return;
      try {
        await exclusive(app.auxDb, (s) => s.run("VACUUM"));
      } catch (error) {
        app.logger.debug("Failed to VACUUM aux database", { error });
      }
    },
    { id: "__pbAppLoggerOnSettingsReload__", priority: -999 },
  );

  return logger;
}

export async function deleteOldLogs(app: App, maxDays: number): Promise<void> {
  await app.auxDb.write(() =>
    app.auxDb.run("DELETE FROM _logs WHERE created <= ?", [
      daysAgo(app, maxDays),
    ]),
  );
}
