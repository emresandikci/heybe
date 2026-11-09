import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { App } from "../../app";
import { newAuthToken } from "../../auth/tokens";
import { internalRecords } from "../../records/internal";
import { testApp } from "../../test-app";
import { errorResponse } from "../errors";
import { loadAuth } from "../middlewares";
import { createEvent } from "../router";
import { createRouter } from "../server";
import { executeQuery, goFloatString } from "./sql";

let app: App;
let seq = 0;

beforeEach(async () => {
  app = testApp();
  await run(
    "CREATE TABLE sq_a (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL, data BLOB, note varchar(10))",
  );
});

afterEach(() => app.close());

const run = (query: string) => executeQuery(app, query, 1000);
const rows = async (query: string) => (await run(query)).rows;

async function call(body: unknown, as?: string): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (as) {
    const records = internalRecords(app, as);
    const created = await records.create({
      email: `sq${seq++}@example.com`,
      password: "1234567890",
    });
    headers.authorization = await newAuthToken(
      app,
      app.collections.find(as)!,
      records.findRaw(created.id as string),
    );
  }
  const req = new Request("http://x/api/sql", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const found = createRouter().build().match("POST", "/api/sql")!;
  const e = createEvent(app, req, found.params, "1.2.3.4", found.pattern);
  e.auth = loadAuth(app, req);
  try {
    return await found.run(e);
  } catch (err) {
    return errorResponse(err);
  }
}

test("goFloatString matches Go's shortest 'g' format", () => {
  const cases: [number, string][] = [
    [1.5, "1.5"],
    [100, "100"],
    [1234567, "1.234567e+06"],
    [123456, "123456"],
    [0.0001, "0.0001"],
    [0.00001, "1e-05"],
    [-2.5e-7, "-2.5e-07"],
    [1e21, "1e+21"],
    [0.1 + 0.2, "0.30000000000000004"],
    [0, "0"],
    [-0, "-0"],
    [1e100, "1e+100"],
    [Infinity, "+Inf"],
    [-Infinity, "-Inf"],
    [NaN, "NaN"],
  ];
  for (const [v, s] of cases) expect([v, goFloatString(v)]).toEqual([v, s]);
});

describe("executeQuery", () => {
  test("multi-statement insert applies both rows", async () => {
    const result = await run(
      "INSERT INTO sq_a (name) VALUES ('a'); INSERT INTO sq_a (name) VALUES ('b')",
    );
    expect(result).toMatchObject({ affectedRows: 1, columns: [], rows: [] });
    expect(await rows("SELECT name FROM sq_a ORDER BY id")).toEqual([
      ["a"],
      ["b"],
    ]);
  });

  test("a failing second statement rolls back the first", async () => {
    await expect(
      run(
        "INSERT INTO sq_a (name) VALUES ('a'); INSERT INTO sq_a (name) VALUES (NULL)",
      ),
    ).rejects.toThrow(
      "constraint failed: NOT NULL constraint failed: sq_a.name (1299)",
    );
    expect(await rows("SELECT count(*) FROM sq_a")).toEqual([["0"]]);
  });

  test("affected rows of updates", async () => {
    await run("INSERT INTO sq_a (name) VALUES ('a'), ('b'), ('c')");
    expect((await run("update sq_a SET note = 'n'")).affectedRows).toBe(3);
  });

  test("lowercase and indented select", async () => {
    await run("INSERT INTO sq_a (name) VALUES ('a')");
    expect(await run("  \n\tselect id, name from sq_a")).toMatchObject({
      affectedRows: 0,
      columns: [
        { name: "id", type: "INTEGER", nullable: true },
        { name: "name", type: "TEXT", nullable: true },
      ],
      rows: [["1", "a"]],
    });
  });

  test("WITH select and PRAGMA run through the read path", async () => {
    expect(
      await rows("WITH x AS (SELECT 1 AS n UNION SELECT 2) SELECT n FROM x"),
    ).toEqual([["1"], ["2"]]);
    expect(await run("PRAGMA user_version = 7")).toMatchObject({
      columns: [],
      rows: [],
    });
    expect(await rows("PRAGMA user_version")).toEqual([["7"]]);
  });

  test("VACUUM succeeds", async () => {
    expect(await run("VACUUM")).toMatchObject({ affectedRows: 0, rows: [] });
  });

  test("1500 rows are capped at 1000", async () => {
    const query =
      "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 1500) SELECT n FROM c";
    const result = await rows(query);
    expect(result).toHaveLength(1000);
    expect(result.at(-1)).toEqual(["1000"]);
    expect(await executeQuery(app, query, 2)).toMatchObject({
      rows: [["1"], ["2"]],
    });
  });

  test("duplicate column names keep every value", async () => {
    expect(await rows("SELECT 1 AS a, 2 AS a")).toEqual([["1", "2"]]);
  });

  test("9007199254740993 comes back exact", async () => {
    expect(
      await rows("SELECT 9007199254740993, -9223372036854775808, 1.5, 100.0"),
    ).toEqual([["9007199254740993", "-9223372036854775808", "1.5", "100"]]);
  });

  test("blob and null values", async () => {
    expect(await rows("SELECT x'68656c6c6f', x'ff00', x'', NULL, ''")).toEqual([
      ["hello", "�\u0000", "", null, ""],
    ]);
  });

  test("declared and expression column types", async () => {
    const { columns } = await run(
      "SELECT id, name, score, data, note, 1 + 1 AS expr, NULL AS n FROM sq_a",
    );
    expect(columns.map((c) => [c.name, c.type, c.nullable])).toEqual([
      ["id", "INTEGER", true],
      ["name", "TEXT", true],
      ["score", "REAL", true],
      ["data", "BLOB", true],
      ["note", "VARCHAR(10)", true],
      ["expr", "", true],
      ["n", "", true],
    ]);
  });

  const appInsert = (name: string) =>
    app.db.write(() =>
      app.db.run("INSERT INTO sq_a (name) VALUES (?)", [name]),
    );

  test("a BEGIN read query does not leave the writer in a transaction", async () => {
    await run("BEGIN");
    await appInsert("app");
    await run("INSERT INTO sq_a (name) VALUES ('api')");
    expect(
      app.db.query("SELECT name FROM sq_a ORDER BY id").map((r: any) => r.name),
    ).toEqual(["app", "api"]);
  });

  test("PRAGMA query_only does not stick to the writer", async () => {
    await run("PRAGMA query_only = 1");
    await appInsert("app");
    expect(await rows("SELECT name FROM sq_a")).toEqual([["app"]]);
  });

  test("whitespace-only query gives empty query", async () => {
    await expect(run("  \n ")).rejects.toThrow("empty query");
  });

  test("errors use the Go driver's format", async () => {
    await expect(run("SELEC 1")).rejects.toThrow(
      'SQL logic error: near "SELEC": syntax error (1)',
    );
    await expect(run("SELECT * FROM sq_missing")).rejects.toThrow(
      "SQL logic error: no such table: sq_missing (1)",
    );
  });
});

describe("POST /api/sql", () => {
  test("superusers get the result", async () => {
    const res = await call({ query: "SELECT 1 AS n" }, "_superusers");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      affectedRows: 0,
      columns: [{ name: "n", type: "", nullable: true }],
      rows: [["1"]],
    });
  });

  test("5001 chars (UTF-8 bytes) fails validation", async () => {
    const res = await call(
      { query: `SELECT '${"x".repeat(4992)}'` },
      "_superusers",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      status: 400,
      message: "An error occurred while validating the submitted data.",
      data: {
        query: {
          code: "validation_length_too_long",
          message: "The length must be no more than 5000.",
          params: { max: 5000, min: 0 },
        },
      },
    });
    const bytes = (n: number) =>
      call({ query: `SELECT '${"é".repeat(n)}'` }, "_superusers");
    expect((await bytes(2495)).status).toBe(200);
    expect((await bytes(2496)).status).toBe(400);
  });

  test("execution errors are 400 with the raw error", async () => {
    const res = await call({ query: "   " }, "_superusers");
    expect(await res.json()).toEqual({
      status: 400,
      message: "Failed to execute query. Raw error:\nempty query.",
      data: {},
    });
  });

  test("guest 401, user 403", async () => {
    expect((await call({ query: "SELECT 1" })).status).toBe(401);
    expect((await call({ query: "SELECT 1" }, "users")).status).toBe(403);
  });
});
