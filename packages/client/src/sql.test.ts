import { expect, test } from "bun:test";
import { createClientWith } from "./client.js";
import { fakeEnv } from "./test-env.js";

test("sql.run posts the query and returns the result", async () => {
  const env = fakeEnv();
  const result = { execTime: 1, affectedRows: 0, columns: [], rows: [] };
  env.respond(() => Response.json(result));
  const client = createClientWith("http://a", {}, env);
  expect(await client.sql.run("select 1")).toEqual(result);
  expect(env.requests.at(-1)).toMatchObject({
    method: "POST",
    url: "http://a/api/sql",
    body: '{"query":"select 1"}',
  });
});
