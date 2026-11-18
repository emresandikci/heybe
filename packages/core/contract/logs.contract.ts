import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Target,
  both,
  expectSame,
  flushLogs,
  startTargets,
  waitUntil,
} from "./harness";

let targets: Awaited<ReturnType<typeof startTargets>>;

type Json = Record<string, any>;

const userTokens: Record<Target["name"], string> = {
  pocketbase: "",
  heybe: "",
};
const logIds: Record<Target["name"], string> = { pocketbase: "", heybe: "" };

const FILTER = encodeURIComponent("data.url~'/api/collections/lg_'");
const FILTER_QUERY = `filter=${FILTER}`;

const api = (
  t: Target,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = t.superToken,
) =>
  fetch(`${t.url}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === null ? {} : { authorization: token }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// execTime and the hour of a stats bucket differ between runs. PB logs the raw Go error as details
// ("sql: no rows in result set", "cannot be blank"), so only the failing field names are compared.
async function logsApi(
  t: Target,
  path: string,
  token: string | null = t.superToken,
  method = "GET",
): Promise<Response> {
  const res = await api(t, method, `/api/logs${path}`, undefined, token);
  if (!res.headers.get("content-type")?.includes("json")) return res;
  const body = (await res.json()) as Json;
  const clear = (log: Json) => {
    const data = { ...log.data, execTime: 0 };
    if ("details" in data)
      data.details =
        typeof data.details === "object" ? Object.keys(data.details) : [];
    return { ...log, data };
  };
  let out: unknown = body;
  if (Array.isArray(body))
    out = [{ date: "<hour>", total: body.reduce((n, i) => n + i.total, 0) }];
  else if (Array.isArray(body.items))
    out = { ...body, items: body.items.map(clear) };
  else if (body.data?.execTime !== undefined) out = clear(body);
  return Response.json(out, { status: res.status, headers: res.headers });
}

const total = async (t: Target, query: string) =>
  ((await (await logsApi(t, `?${query}&perPage=1`)).json()) as Json)
    .totalItems as number;

async function settled(query: string, expected?: number) {
  await Promise.all(
    targets.pb && [flushLogs(targets.pb), flushLogs(targets.hb)],
  );
  await waitUntil(
    () => Promise.all([total(targets.pb, query), total(targets.hb, query)]),
    ([pb, hb]) => pb === hb && (expected === undefined || pb === expected),
  );
}

beforeAll(async () => {
  targets = await startTargets();
  const [pb, hb] = await both((t) =>
    api(t, "POST", "/api/collections", {
      name: "lg_items",
      type: "base",
      fields: [{ name: "title", type: "text", required: true }],
    }),
  );
  expect(pb.status).toBe(200);
  expect(hb.status).toBe(200);
  await both((t) => api(t, "GET", "/api/collections/lg_items/records"));
  await both((t) =>
    api(t, "GET", "/api/collections/lg_items/records/missingrecord1"),
  );
  await both((t) => api(t, "POST", "/api/collections/lg_items/records", {}));
  await both((t) => api(t, "GET", "/api/settings"));
  await both((t) =>
    api(
      t,
      "POST",
      "/api/collections/users/records",
      {
        email: "lg@example.com",
        password: "1234567890",
        passwordConfirm: "1234567890",
      },
      null,
    ),
  );
  await Promise.all(
    [targets.pb, targets.hb].map(async (t) => {
      const res = await api(
        t,
        "POST",
        "/api/collections/users/auth-with-password",
        { identity: "lg@example.com", password: "1234567890" },
        null,
      );
      userTokens[t.name] = ((await res.json()) as Json).token;
    }),
  );
  await settled(FILTER_QUERY, 3);
}, 60_000);

afterAll(async () => {
  await targets.stop();
});

describe("logs", () => {
  test("list matches PocketBase", async () => {
    const [pb, hb] = await both((t) =>
      logsApi(t, `?filter=${FILTER}&sort=created`),
    );
    expect(pb.status).toBe(200);
    expect((pb.body as Json).items).toHaveLength(3);
    expect((pb.body as Json).items[2].data.details).toEqual(["title"]);
    expectSame(pb, hb);
  });

  test("stats match PocketBase", async () => {
    const [pb, hb] = await both((t) => logsApi(t, `/stats?filter=${FILTER}`));
    expect(pb.status).toBe(200);
    expect(pb.body).toEqual([{ date: "<hour>", total: 3 }]);
    expectSame(pb, hb);
  });

  test("view and a missing id", async () => {
    await Promise.all(
      [targets.pb, targets.hb].map(async (t) => {
        const res = await logsApi(t, `?filter=${FILTER}&sort=created`);
        logIds[t.name] = ((await res.json()) as Json).items[0].id;
      }),
    );
    const [view, missing] = [
      await both((t) => logsApi(t, `/${logIds[t.name]}`)),
      await both((t) => logsApi(t, "/missinglogid123")),
    ];
    expect(view[0].status).toBe(200);
    expectSame(...view);
    expect(missing[0].status).toBe(404);
    expectSame(...missing);
  });

  test("filter on the auth collection", async () => {
    const query = `filter=${encodeURIComponent("data.auth='_superusers'")}&sort=created`;
    await settled(query);
    const [pb, hb] = await both((t) => logsApi(t, `?${query}`));
    expect(pb.status).toBe(200);
    expect((pb.body as Json).items.length).toBeGreaterThan(3);
    expectSame(pb, hb);
  });

  test("a bad filter is the same 400", async () => {
    const [pb, hb] = await both((t) => logsApi(t, "?filter=nope~1"));
    expect(pb.status).toBe(400);
    expectSame(pb, hb);
  });

  test("guests and users are rejected on every logs route", async () => {
    for (const [method, path] of [
      ["GET", ""],
      ["GET", "/stats"],
      ["GET", "/missinglogid123"],
      ["DELETE", ""],
    ] as const) {
      const [guest, user] = [
        await both((t) => logsApi(t, path, null, method)),
        await both((t) => logsApi(t, path, userTokens[t.name], method)),
      ];
      expect(guest[0].status).toBe(401);
      expectSame(...guest);
      expect(user[0].status).toBe(403);
      expectSame(...user);
    }
  });

  test("truncate empties the list", async () => {
    await settled("");
    const [del, list] = [
      await both((t) => logsApi(t, "", t.superToken, "DELETE")),
      await both((t) => logsApi(t, "?sort=created&perPage=1")),
    ];
    expect(del[0].status).toBe(204);
    expectSame(...del);
    expect((list[0].body as Json).items).toEqual([]);
    expectSame(...list);
  });
});
