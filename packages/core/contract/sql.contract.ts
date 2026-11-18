import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Target, both, expectSame, startTargets } from "./harness";

let targets: Awaited<ReturnType<typeof startTargets>>;

type Json = Record<string, any>;

const userTokens: Record<Target["name"], string> = {
  pocketbase: "",
  heybe: "",
};

async function sql(
  t: Target,
  body: unknown,
  token: string | null = t.superToken,
): Promise<Response> {
  const res = await fetch(`${t.url}/api/sql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: token }),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Json;
  if (typeof json.execTime === "number") json.execTime = 0;
  return Response.json(json, { status: res.status, headers: res.headers });
}

async function same(query: string, status = 200) {
  const [pb, hb] = await both((t) => sql(t, { query }));
  expect(pb.status).toBe(status);
  expectSame(pb, hb);
  return pb.body as Json;
}

beforeAll(async () => {
  targets = await startTargets();
  // affectedRows of DDL is the stale count of the connection's last write, so it is not compared
  const [pb, hb] = await both((t) =>
    sql(t, {
      query:
        "CREATE TABLE sq_a (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, score REAL, data BLOB, note varchar(10))",
    }),
  );
  expect(pb.status).toBe(200);
  expect(hb.status).toBe(200);
  await Promise.all(
    [targets.pb, targets.hb].map(async (t) => {
      const create = await fetch(`${t.url}/api/collections/users/records`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "sq@example.com",
          password: "1234567890",
          passwordConfirm: "1234567890",
        }),
      });
      expect(create.status).toBe(200);
      const res = await fetch(
        `${t.url}/api/collections/users/auth-with-password`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            identity: "sq@example.com",
            password: "1234567890",
          }),
        },
      );
      userTokens[t.name] = ((await res.json()) as Json).token;
    }),
  );
}, 60_000);

afterAll(async () => {
  await targets.stop();
});

describe("sql", () => {
  test("multi-statement insert applies both rows", async () => {
    await same(
      "INSERT INTO sq_a (name, score) VALUES ('a', 1.5); INSERT INTO sq_a (name, data) VALUES ('b', x'68656c6c6f')",
    );
    const body = await same("SELECT id, name FROM sq_a ORDER BY id");
    expect(body.rows).toEqual([
      ["1", "a"],
      ["2", "b"],
    ]);
  });

  test("a failing second statement rolls back the first", async () => {
    await same(
      "INSERT INTO sq_a (name) VALUES ('c'); INSERT INTO sq_a (name) VALUES (NULL)",
      400,
    );
    const body = await same("SELECT count(*) FROM sq_a");
    expect(body.rows).toEqual([["2"]]);
  });

  test("UNIQUE violation, syntax error and missing table", async () => {
    await same("INSERT INTO sq_a (name) VALUES ('a')", 400);
    await same("SELEC 1", 400);
    await same("SELECT * FROM sq_missing", 400);
  });

  test("update and delete report affected rows", async () => {
    const body = await same("UPDATE sq_a SET note = 'n'");
    expect(body.affectedRows).toBe(2);
    await same("DELETE FROM sq_a WHERE name = 'zz'");
    await same("DELETE FROM sq_a WHERE name = 'zz'; SELECT 1");
  });

  test("lowercase and indented select", async () => {
    await same("  \n\tselect id, name from sq_a order by id");
  });

  test("WITH select and PRAGMA run through the read path", async () => {
    await same("WITH x AS (SELECT 1 AS n UNION SELECT 2) SELECT n FROM x");
    await same("PRAGMA user_version = 7");
    await same("PRAGMA user_version");
  });

  test("big integers, floats, blobs and nulls", async () => {
    await same(
      "SELECT 9007199254740993 AS big, -9223372036854775808 AS min, 1.5, 100.0, 1234567.0, 0.0001, 0.00001, -2.5e-7, 1e21, 0.1 + 0.2",
    );
    await same(
      "SELECT x'68656c6c6f' AS b, x'ff00' AS bad, x'' AS empty, NULL AS n, '' AS s",
    );
  });

  test("declared and expression column types", async () => {
    await same(
      "SELECT id, name, score, data, note, 1 + 1 AS expr, 'x' AS s, 1.5 AS r, NULL AS n FROM sq_a ORDER BY id",
    );
    await same("SELECT * FROM sq_a WHERE id = -1");
  });

  test("empty, whitespace-only and too long queries", async () => {
    await same("", 400);
    await same("   \n ", 400);
    // the limit counts UTF-8 bytes
    await same(`SELECT '${"é".repeat(2495)}'`);
    await same(`SELECT '${"é".repeat(2496)}'`, 400);
    await same(`SELECT '${"x".repeat(4992)}'`, 400);
    for (const body of [{}, { query: 5 }]) {
      const [pb, hb] = await both((t) => sql(t, body));
      expect(pb.status).toBe(400);
      expectSame(pb, hb);
    }
  });

  test("guests get 401 and users 403", async () => {
    const [pb, hb] = await both((t) => sql(t, { query: "SELECT 1" }, null));
    expect(pb.status).toBe(401);
    expectSame(pb, hb);
    const [pbUser, hbUser] = await both((t) =>
      sql(t, { query: "SELECT 1" }, userTokens[t.name]),
    );
    expect(pbUser.status).toBe(403);
    expectSame(pbUser, hbUser);
  });
});
