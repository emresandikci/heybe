import { SQLiteError } from "bun:sqlite";
import type { App } from "../../app";
import { exclusive, openSibling } from "../../db";
import { ApiError } from "../errors";
import { requireSuperuserAuth } from "../middlewares";
import type { RequestEvent, Router } from "../router";

const MAX_ROWS = 1000;
const MAX_LENGTH = 5000;
const LOAD_FAILED = "An error occurred while loading the submitted data.";
const WRITE_PREFIXES = [
  "INSERT",
  "CREATE",
  "UPDATE",
  "DELETE",
  "DROP",
  "DETACH",
  "ALTER",
  "REPLACE",
];

export interface SqlColumn {
  name: string;
  type: string;
  nullable: boolean;
}

export interface SqlResult {
  execTime: number;
  affectedRows: number;
  columns: SqlColumn[];
  rows: (string | null)[][];
}

// sqlite3_errstr by primary result code
const ERRSTR = [
  "not an error",
  "SQL logic error",
  "unknown error",
  "access permission denied",
  "query aborted",
  "database is locked",
  "database table is locked",
  "out of memory",
  "attempt to write a readonly database",
  "interrupted",
  "disk I/O error",
  "database disk image is malformed",
  "unknown operation",
  "database or disk is full",
  "unable to open database file",
  "locking protocol",
  "unknown error",
  "database schema has changed",
  "string or blob too big",
  "constraint failed",
  "datatype mismatch",
  "bad parameter or other API misuse",
  "unknown error",
  "authorization denied",
  "unknown error",
  "column index out of range",
  "file is not a database",
  "notification message",
  "warning message",
];

// the error text of PB's Go SQLite driver (modernc.org/sqlite)
function driverError(err: unknown): unknown {
  if (!(err instanceof SQLiteError)) return err;
  const rc = err.errno;
  const str =
    rc === 516
      ? "abort due to ROLLBACK"
      : (ERRSTR[rc & 0xff] ?? "unknown error");
  const busy = rc === 5 ? " (SQLITE_BUSY)" : "";
  return new Error(
    err.message === str
      ? `${str} (${rc})${busy}`
      : `${str}: ${err.message} (${rc})${busy}`,
  );
}

// Go strconv.FormatFloat(v, 'g', -1, 64)
export function goFloatString(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (!Number.isFinite(v)) return v > 0 ? "+Inf" : "-Inf";
  if (Object.is(v, -0)) return "-0";
  const [mantissa, exp] = v.toExponential().split("e") as [string, string];
  const e = Number(exp);
  if (e >= -4 && e < 6) return String(v);
  return `${mantissa}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
}

const utf8 = new TextDecoder();

function goString(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return goFloatString(v);
  if (v instanceof Uint8Array) return utf8.decode(v);
  return String(v);
}

function isWrite(query: string): boolean {
  const upper = query.toUpperCase();
  return (
    !upper.startsWith("SELECT") &&
    WRITE_PREFIXES.some((p) => upper.startsWith(p))
  );
}

// PB runs read queries on its concurrent pool; here both kinds hold the write mutex on the writer
// so a query cannot see or break an open write.
export async function executeQuery(
  app: App,
  query: string,
  maxRows: number,
): Promise<SqlResult> {
  query = query.trim();
  if (query === "") throw new Error("empty query");
  const started = performance.now();
  const result: SqlResult = {
    execTime: 0,
    affectedRows: 0,
    columns: [],
    rows: [],
  };
  try {
    if (isWrite(query))
      // changes() is the count of the last statement, like PB's driver
      result.affectedRows = await exclusive(app.db, (s) => {
        try {
          return s
            .transaction(() => {
              s.run(query);
              return s.query<{ n: number }, []>("SELECT changes() AS n").get()!
                .n;
            })
            .immediate();
        } finally {
          if (s.inTransaction) s.run("ROLLBACK");
        }
      });
    else
      // any query may change connection state (BEGIN, PRAGMA query_only), so it gets its own connection
      await exclusive(app.db, (writer) => {
        const s = openSibling(writer);
        try {
          const stmt = s.prepare(query).safeIntegers(true);
          try {
            const names = stmt.columnNames;
            // iterate gives objects, which lose duplicate column names
            if (new Set(names).size === names.length) {
              for (const row of stmt.iterate() as Iterable<
                Record<string, unknown>
              >) {
                if (result.rows.length >= maxRows) break;
                result.rows.push(names.map((n) => goString(row[n])));
              }
            } else
              result.rows = stmt
                .values()
                .slice(0, maxRows)
                .map((row) => row.map(goString));
            result.columns = names.map((name, i) => ({
              name,
              type: (stmt.declaredTypes[i] ?? "").toUpperCase(),
              nullable: true,
            }));
          } finally {
            stmt.finalize();
          }
        } finally {
          s.close();
        }
      });
  } catch (err) {
    throw driverError(err);
  }
  result.execTime = Math.floor(performance.now() - started);
  return result;
}

async function runSql(e: RequestEvent) {
  let body: Record<string, unknown>;
  try {
    body = await e.body();
  } catch (err) {
    if (err instanceof ApiError && err.status === 413) throw err;
    throw new ApiError(400, LOAD_FAILED);
  }
  const query = body.query ?? "";
  if (typeof query !== "string") throw new ApiError(400, LOAD_FAILED);
  const issue =
    query === ""
      ? { code: "validation_required", message: "Cannot be blank." }
      : Buffer.byteLength(query) > MAX_LENGTH
        ? {
            code: "validation_length_too_long",
            message: `The length must be no more than ${MAX_LENGTH}.`,
            params: { max: MAX_LENGTH, min: 0 },
          }
        : null;
  if (issue)
    throw new ApiError(
      400,
      "An error occurred while validating the submitted data.",
      { query: issue },
    );
  let result: SqlResult;
  try {
    result = await executeQuery(e.app, query, MAX_ROWS);
  } catch (err) {
    throw new ApiError(
      400,
      `Failed to execute query. Raw error:\n${(err as Error).message}`,
    );
  }
  return e.json(200, result);
}

export function registerSqlRoutes(router: Router): void {
  router.group("/api/sql").use(requireSuperuserAuth()).post("", runSql);
}
