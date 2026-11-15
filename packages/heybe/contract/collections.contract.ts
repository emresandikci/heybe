import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Snapshot,
  type Target,
  both,
  expectSame,
  startTargets,
} from "./harness";

let targets: Awaited<ReturnType<typeof startTargets>>;

beforeAll(async () => {
  targets = await startTargets();
}, 60_000);

afterAll(async () => {
  await targets.stop();
});

type Json = Record<string, any>;

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
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });

const fetchJson = async (t: Target, path: string): Promise<Json> =>
  (await api(t, "GET", path)).json() as Promise<Json>;

async function same(
  fn: (t: Target) => Promise<Response>,
  status?: number,
): Promise<Snapshot> {
  const [pb, hb] = await both(fn);
  if (status !== undefined) expect(pb.status).toBe(status);
  expectSame(pb, hb);
  return pb;
}

const create =
  (name: string, extra: Json = {}) =>
  (t: Target) =>
    api(t, "POST", "/api/collections", { name, ...extra });

const text = (name: string, extra: Json = {}) => ({
  name,
  type: "text",
  ...extra,
});

describe("system collections", () => {
  for (const name of [
    "_superusers",
    "users",
    "_mfas",
    "_otps",
    "_externalAuths",
    "_authOrigins",
  ]) {
    test(`${name} matches`, async () => {
      await same((t) => api(t, "GET", `/api/collections/${name}`), 200);
    });
  }

  test("the default list matches", async () => {
    await same((t) => api(t, "GET", "/api/collections"), 200);
  });
});

describe("create and view", () => {
  test("a base collection with every field type", async () => {
    const fields = [
      text("title", { required: true, min: 2, max: 50, pattern: "^[a-z]+$" }),
      { name: "count", type: "number", min: 1, max: 9.5, onlyInt: false },
      { name: "active", type: "bool" },
      { name: "mail", type: "email", onlyDomains: ["example.com"] },
      { name: "site", type: "url", exceptDomains: ["bad.com"] },
      {
        name: "when",
        type: "date",
        min: "2020-01-01",
        max: "2030-01-01 10:00:00",
      },
      { name: "stamp", type: "autodate", onCreate: true, onUpdate: true },
      { name: "kind", type: "select", values: ["a", "b", "c"], maxSelect: 2 },
      { name: "data", type: "json", maxSize: 1000 },
      {
        name: "owner",
        type: "relation",
        collectionId: "_pb_users_auth_",
        maxSelect: 1,
      },
      {
        name: "doc",
        type: "file",
        maxSelect: 2,
        maxSize: 100,
        thumbs: ["100x100"],
      },
      { name: "secret", type: "password", min: 5, max: 20, cost: 8 },
    ];
    const created = await same(
      create("ct_all", {
        fields,
        listRule: "",
        createRule: "@request.auth.id != ''",
      }),
      200,
    );
    expect((created.body as Json).fields).toHaveLength(13);
    await same((t) => api(t, "GET", "/api/collections/ct_all"), 200);
    await same(
      (t) => api(t, "GET", "/api/collections/ct_all?fields=name"),
      200,
    );
  });

  test("view by id and by uppercase name", async () => {
    await same((t) => api(t, "GET", "/api/collections/pbc_3142635823"), 200);
    await same((t) => api(t, "GET", "/api/collections/CT_ALL"), 200);
  });

  test("an auth collection with every field type and custom options", async () => {
    const fields = [
      text("name", { max: 100 }),
      { name: "age", type: "number" },
      { name: "avatar", type: "file", maxSelect: 1 },
    ];
    await same(
      create("ct_auth", {
        type: "auth",
        fields,
        authRule: "verified = true",
        manageRule: "id != ''",
        passwordAuth: { enabled: true, identityFields: ["email"] },
        authToken: { duration: 3600 },
        otp: { enabled: true, duration: 300, length: 6 },
        mfa: { enabled: true, duration: 700, rule: "id != ''" },
        verificationTemplate: { subject: "Verify", body: "<p>Hi</p>" },
        indexes: ["CREATE INDEX `idx_ct_auth_name` ON `ct_auth` (`name`)"],
      }),
      200,
    );
    await same((t) => api(t, "GET", "/api/collections/ct_auth"), 200);
  });

  test("minimal base, explicit id, and a scaffold auth collection", async () => {
    await same(create("ct_min"), 200);
    await same(create("ct_withid", { id: "customid1234567" }), 200);
    await same(create("ct_min_auth", { type: "auth" }), 200);
    await same((t) => api(t, "GET", "/api/collections/ct_withid"), 200);
  });

  test("unknown field keys are dropped and nulls reset values", async () => {
    await same(
      create("ct_nulls", {
        fields: [text("a", { min: null, required: null, extra: "x" })],
        listRule: null,
      }),
      200,
    );
  });

  test("duplicate indexes with explicit table names stay as written", async () => {
    await same(
      create("ct_idx", {
        fields: [text("a"), text("b")],
        indexes: [
          "CREATE UNIQUE INDEX idx_ct_idx_a ON ct_idx (a)",
          "CREATE INDEX idx_ct_idx_ab ON other_table (a, b DESC)",
        ],
      }),
      200,
    );
  });
});

describe("list", () => {
  test("filter by type", async () => {
    await same(
      (t) =>
        api(
          t,
          "GET",
          `/api/collections?filter=${encodeURIComponent('type="auth"')}&sort=name`,
        ),
      200,
    );
  });

  test("sort and paging", async () => {
    await same(
      (t) => api(t, "GET", "/api/collections?sort=-name&perPage=2&page=2"),
      200,
    );
    await same(
      (t) => api(t, "GET", "/api/collections?sort=system,-created&perPage=3"),
      200,
    );
    await same(
      (t) => api(t, "GET", "/api/collections?sort=-@rowid&perPage=2"),
      200,
    );
    await same((t) => api(t, "GET", "/api/collections?perPage=2&page=99"), 200);
    await same(
      (t) => api(t, "GET", "/api/collections?perPage=5000&skipTotal=1"),
      200,
    );
    await same((t) => api(t, "GET", "/api/collections?perPage=-1&page=0"), 200);
    await same((t) => api(t, "GET", "/api/collections?sort=-type"), 200);
    await same((t) => api(t, "GET", "/api/collections?sort=type,-name"), 200);
    await same((t) => api(t, "GET", "/api/collections?page=&perPage="), 200);
    await same(
      (t) => api(t, "GET", "/api/collections?perPage=2&fields=id,name"),
      200,
    );
  });

  test("filters over the allowed columns", async () => {
    for (const filter of [
      "system=false && name~'ct_'",
      "name~'%all'",
      "name?='users'",
      "id=name",
      "name!=null",
      "created>@yesterday && type!='view'",
      "(name='users' || name='_superusers')",
      "strftime('%Y', created) > 2000",
      "geoDistance(1, 2, 3, 4) > 0 || name = 'users'",
    ]) {
      await same(
        (t) =>
          api(
            t,
            "GET",
            `/api/collections?sort=name&filter=${encodeURIComponent(filter)}`,
          ),
        200,
      );
    }
  });

  test("invalid query parameters", async () => {
    for (const query of [
      "filter=foo%3D%22x%22",
      "filter=name%3D",
      "filter=%40request.auth.id!%3D%22%22",
      "sort=foo",
      "sort=name,",
      "sort=name:lower",
      "page=x",
      "perPage=1.5",
      "page=99999999999999999999",
      "skipTotal=abc",
    ]) {
      await same((t) => api(t, "GET", `/api/collections?${query}`), 400);
    }
  });
});

describe("update", () => {
  const initial = [text("title"), text("body"), { name: "n", type: "number" }];

  test("adds, renames and removes fields", async () => {
    await same(create("ct_upd", { fields: initial }), 200);
    const patch = (fn: (c: Json) => Json) => (t: Target) =>
      fetchJson(t, "/api/collections/ct_upd").then((c) =>
        api(t, "PATCH", "/api/collections/ct_upd", fn(c)),
      );

    await same(
      patch((c) => ({ fields: [...c.fields, text("extra")] })),
      200,
    );
    await same(
      patch((c) => ({
        fields: c.fields.map((f: Json) =>
          f.name === "title" ? { ...f, name: "heading" } : f,
        ),
      })),
      200,
    );
    await same(
      patch((c) => ({
        fields: c.fields.filter((f: Json) => f.name !== "body"),
      })),
      200,
    );
    await same((t) => api(t, "GET", "/api/collections/ct_upd"), 200);
  });

  test("partial update keeps the rest", async () => {
    await same(
      (t) =>
        api(t, "PATCH", "/api/collections/ct_upd", {
          listRule: "id != ''",
          viewRule: "",
        }),
      200,
    );
    await same(
      (t) => api(t, "PATCH", "/api/collections/ct_upd", { listRule: null }),
      200,
    );
  });

  test("renaming the collection rewrites the index table names", async () => {
    await same(
      create("ct_ren", {
        fields: [text("a"), text("b")],
        indexes: [
          "CREATE UNIQUE INDEX idx_ct_ren_a ON ct_ren (a)",
          "CREATE INDEX idx_ct_ren_ab ON ct_ren (a, b)",
        ],
      }),
      200,
    );
    await same(
      (t) => api(t, "PATCH", "/api/collections/ct_ren", { name: "ct_ren2" }),
      200,
    );
    await same((t) => api(t, "GET", "/api/collections/ct_ren2"), 200);
    await same((t) => api(t, "GET", "/api/collections/ct_ren"), 404);
  });

  test("renaming a field used by an index fails like PB", async () => {
    await same(
      create("ct_idxren", {
        fields: [text("a"), text("b")],
        indexes: [
          "CREATE INDEX idx_ct_idxren_a ON ct_idxren (a)",
          "CREATE UNIQUE INDEX idx_ct_idxren_ab ON ct_idxren (a, b DESC) WHERE a != ''",
        ],
      }),
      200,
    );
    await same(
      (t) =>
        fetchJson(t, "/api/collections/ct_idxren").then((c) =>
          api(t, "PATCH", "/api/collections/ct_idxren", {
            fields: c.fields.map((f: Json) =>
              f.name === "a" ? { ...f, name: "renamed" } : f,
            ),
          }),
        ),
      400,
    );
  });

  test("removing a field used by an index fails like PB", async () => {
    await same(
      create("ct_idxfail", {
        fields: [text("a"), text("b")],
        indexes: ["CREATE INDEX idx_ct_idxfail_a ON ct_idxfail (a)"],
      }),
      200,
    );
    await same(
      (t) =>
        fetchJson(t, "/api/collections/ct_idxfail").then((c) =>
          api(t, "PATCH", "/api/collections/ct_idxfail", {
            fields: c.fields.filter((f: Json) => f.name !== "a"),
          }),
        ),
      400,
    );
  });

  test("the superusers collection keeps password auth on and OAuth2 off", async () => {
    await same(
      (t) =>
        api(t, "PATCH", "/api/collections/_superusers", {
          passwordAuth: { enabled: false },
          otp: { enabled: true, duration: 300, length: 6 },
          oauth2: {
            enabled: true,
            providers: [{ name: "google", clientId: "a", clientSecret: "b" }],
          },
        }),
      200,
    );
  });

  test("auth rule change keeps the rest of the options", async () => {
    await same(create("ct_authrule", { type: "auth" }), 200);
    await same(
      (t) =>
        api(t, "PATCH", "/api/collections/ct_authrule", { authRule: null }),
      200,
    );
    await same(
      (t) =>
        api(t, "PATCH", "/api/collections/ct_authrule", {
          authToken: { duration: 600 },
          passwordAuth: { enabled: true, identityFields: ["email"] },
        }),
      200,
    );
  });

  test("oauth2 providers are merged by name", async () => {
    const google = {
      name: "google",
      clientId: "a",
      clientSecret: "b",
      pkce: true,
      authURL: "https://x.com/a",
    };
    await same(
      create("ct_oauth", {
        type: "auth",
        oauth2: {
          enabled: true,
          providers: [
            google,
            { name: "github", clientId: "c", clientSecret: "d" },
          ],
        },
      }),
      200,
    );
    await same(
      (t) =>
        api(t, "PATCH", "/api/collections/ct_oauth", {
          oauth2: {
            providers: [
              { name: "github", clientId: "changed" },
              { name: "google" },
            ],
          },
        }),
      200,
    );
  });

  test("unknown collection, id change, type change, name clash, system rules", async () => {
    await same(
      (t) => api(t, "PATCH", "/api/collections/nope", { name: "x" }),
      404,
    );
    await same(
      (t) => api(t, "PATCH", "/api/collections/ct_upd", { id: "other" }),
      404,
    );
    await same(
      (t) => api(t, "PATCH", "/api/collections/ct_upd", { type: "view" }),
      400,
    );
    await same(
      (t) => api(t, "PATCH", "/api/collections/ct_upd", { name: "users" }),
      400,
    );
    await same(
      (t) => api(t, "PATCH", "/api/collections/_superusers", { listRule: "" }),
      400,
    );
    await same(
      (t) => api(t, "PATCH", "/api/collections/_superusers", { name: "x" }),
      400,
    );
    await same(
      (t) => api(t, "PATCH", "/api/collections/_superusers", { system: false }),
      400,
    );
  });

  test("a removed system field is added back", async () => {
    await same(
      (t) =>
        fetchJson(t, "/api/collections/_superusers").then((c) =>
          api(t, "PATCH", "/api/collections/_superusers", {
            fields: c.fields.filter((f: Json) => f.name !== "verified"),
          }),
        ),
      200,
    );
  });

  test("changing a field type fails", async () => {
    await same(
      (t) =>
        fetchJson(t, "/api/collections/ct_upd").then((c) =>
          api(t, "PATCH", "/api/collections/ct_upd", {
            fields: c.fields.map((f: Json) =>
              f.name === "n" ? { ...f, type: "text" } : f,
            ),
          }),
        ),
      400,
    );
  });
});

describe("invalid payloads", () => {
  test("missing, duplicate and badly formatted names", async () => {
    await same(create(""), 400);
    await same((t) => api(t, "POST", "/api/collections", {}), 400);
    await same((t) => api(t, "POST", "/api/collections", "", undefined), 400);
    await same(create("ct_min"), 400);
    await same(create("CT_MIN"), 400);
    await same(create("bad name"), 400);
    await same(create("a_via_b"), 400);
    await same(create("x".repeat(256)), 400);
    await same(create("ct_all2", { id: "pbc_1234" }), 200);
    await same(create("ct_withid2", { id: "customid1234567" }), 400);
    await same(create("_collections"), 400);
    await same(create("ct_bad_type", { type: "zzz" }), 400);
  });

  test("bad field definitions", async () => {
    await same(create("ct_bad1", { fields: [text("bad name")] }), 400);
    await same(create("ct_bad2", { fields: [text("a"), text("A")] }), 400);
    await same(create("ct_bad3", { fields: [text("collectionId")] }), 400);
    await same(create("ct_bad4", { fields: [text("x_via_y")] }), 400);
    await same(create("ct_bad5", { fields: [text("")] }), 400);
    await same(create("ct_bad6", { fields: [text("a".repeat(101))] }), 400);
    await same(
      create("ct_bad7", { fields: [text("a", { help: "h".repeat(301) })] }),
      400,
    );
    await same(
      create("ct_bad8", { fields: [{ ...text("id"), primaryKey: false }] }),
      200,
    );
    await same(
      create("ct_bad9", { fields: [text("a", { primaryKey: true })] }),
      400,
    );
  });

  test("bad rules", async () => {
    await same(create("ct_rule1", { listRule: "foo = " }), 400);
    await same(
      create("ct_rule2", {
        viewRule: "a ==",
        createRule: "(",
        fields: [text("a b")],
      }),
      400,
    );
    await same(
      create("ct_rule3", { type: "auth", authRule: "x =", manageRule: "" }),
      400,
    );
  });

  test("rule syntax and field resolution errors", async () => {
    const rules = [
      "foo = ",
      "a ==",
      "(",
      "a = 1 )",
      "a = 'x",
      "= 1",
      "a = 1 && || b = 2",
      "()",
      "a = 1 b = 2",
      "a = {x}",
      "a = -",
      "f( = 1",
      "a = 1 && (b = 2",
      "@request.foo = 1",
      "a = @now2",
      "@collection.nope.a = 1",
      "a.b.c = 1",
      "foo = 1",
      "#a = 1",
      "f(a,) = 1",
      "a = 'x' \\n && a = 'y'",
    ];
    for (const [i, rule] of rules.entries()) {
      await same(
        create(`ct_rx${i}`, { fields: [text("a")], listRule: rule }),
        400,
      );
    }
  });

  test("malformed bodies", async () => {
    await same((t) => api(t, "POST", "/api/collections", "{bad"), 400);
    await same((t) => api(t, "POST", "/api/collections", "[1]"), 400);
    await same((t) => api(t, "POST", "/api/collections", { name: 1 }), 400);
    await same(
      (t) =>
        api(t, "POST", "/api/collections", { name: "ct_m1", fields: "abc" }),
      400,
    );
    await same(create("ct_m2", { fields: [{ name: "q", type: "nope" }] }), 400);
    await same(create("ct_m3", { fields: [text("q", { min: "a" })] }), 400);
    await same(create("ct_m4", { fields: [text("q", { min: 1.5 })] }), 400);
    await same(
      create("ct_m5", { fields: [text("q", { required: "true" })] }),
      400,
    );
    await same(create("ct_m6", { fields: [1] }), 400);
    await same(
      create("ct_m7", { fields: [{ name: "d", type: "date", min: "zzz" }] }),
      200,
    );
    await same(
      create("ct_m8", { fields: [{ name: "s", type: "select", values: [1] }] }),
      400,
    );
    await same(create("ct_m9", { listRule: 5 }), 400);
    await same(create("ct_m10", { type: "auth", authToken: "x" }), 400);
  });

  test("field settings", async () => {
    const cases: Json[] = [
      { name: "s", type: "select" },
      { name: "s", type: "select", values: ["a"], maxSelect: 3 },
      { name: "s", type: "select", values: ["a"], maxSelect: -1 },
      { name: "n", type: "number", min: 5, max: 2 },
      { name: "n", type: "number", min: 3.5, onlyInt: true },
      { name: "r", type: "relation" },
      { name: "r", type: "relation", collectionId: "nope" },
      { name: "r", type: "relation", collectionId: "users" },
      {
        name: "r",
        type: "relation",
        collectionId: "_pb_users_auth_",
        minSelect: 2,
      },
      {
        name: "r",
        type: "relation",
        collectionId: "_pb_users_auth_",
        minSelect: 2,
        maxSelect: 1,
      },
      {
        name: "r",
        type: "relation",
        collectionId: "_pb_users_auth_",
        minSelect: -1,
      },
      text("t", { min: 5, max: 2 }),
      text("t", { min: -1 }),
      text("t", { pattern: "(" }),
      text("t", { autogeneratePattern: "[" }),
      {
        name: "e",
        type: "email",
        onlyDomains: ["a.com"],
        exceptDomains: ["b.com"],
      },
      { name: "e", type: "email", onlyDomains: ["not a domain"] },
      { name: "u", type: "url", exceptDomains: ["###"] },
      { name: "a", type: "autodate" },
      { name: "j", type: "json", maxSize: -1 },
      { name: "f", type: "file", thumbs: ["0x0", "bad"] },
      { name: "f", type: "file", maxSelect: -2 },
      { name: "p", type: "password", min: 0, max: 80 },
      { name: "p", type: "password", cost: 2 },
      { name: "p", type: "password", pattern: "(" },
    ];
    for (const [i, field] of cases.entries()) {
      await same(create(`ct_fs${i}`, { fields: [text("first"), field] }), 400);
    }
  });

  test("auth options", async () => {
    const cases: Json[] = [
      { authToken: { duration: 5 } },
      { authToken: { secret: "short", duration: 100 } },
      { authToken: { duration: 99999999999 } },
      { passwordAuth: { enabled: true, identityFields: [] } },
      { passwordAuth: { enabled: true, identityFields: ["username"] } },
      { passwordAuth: { enabled: true, identityFields: ["verified"] } },
      { mfa: { enabled: true, duration: 600 } },
      {
        mfa: { enabled: true, duration: 5 },
        otp: { enabled: true, duration: 600, length: 8 },
      },
      { otp: { enabled: true, duration: 5, length: 2 } },
      { verificationTemplate: { subject: "", body: "" } },
      { authAlert: { emailTemplate: { subject: "", body: "x" } } },
      { authToken: null, mfa: null },
      {
        oauth2: {
          enabled: true,
          providers: [{ name: "nope", clientId: "a", clientSecret: "b" }],
        },
      },
      { fields: [text("passwordConfirm")] },
      { indexes: ["bad"] },
      { oauth2: { enabled: true, providers: [{ name: "google" }] } },
      {
        oauth2: {
          enabled: true,
          providers: [
            { name: "google", clientId: "a", clientSecret: "b" },
            { name: "google", clientId: "a", clientSecret: "b" },
          ],
        },
      },
      {
        oauth2: {
          enabled: true,
          providers: [
            {
              name: "google",
              clientId: "a",
              clientSecret: "b",
              authURL: "not a url",
            },
          ],
        },
      },
    ];
    for (const [i, extra] of cases.entries()) {
      await same(create(`ct_ao${i}`, { type: "auth", ...extra }), 400);
    }
  });

  test("a text field named email is replaced by the system field", async () => {
    await same(
      create("ct_aoemail", { type: "auth", fields: [text("email")] }),
      200,
    );
  });

  test("index definitions the database rejects", async () => {
    for (const [i, index] of [
      "CREATE INDEX idx_ct_ixdb0 ON ct_ixdb0 (a) WHERE zzz = 1",
      "CREATE INDEX idx_ct_ixdb1 ON ct_ixdb1 (a COLLATE nope)",
    ].entries()) {
      await same(
        create(`ct_ixdb${i}`, { fields: [text("a")], indexes: [index] }),
        400,
      );
    }
  });

  test("index definitions", async () => {
    await same(
      create("ct_ix1", { fields: [text("a")], indexes: ["bad"] }),
      400,
    );
    await same(
      create("ct_ix2", {
        fields: [text("a")],
        indexes: [
          "CREATE INDEX i ON ct_ix2 (a)",
          "CREATE INDEX i ON ct_ix2 (a)",
        ],
      }),
      400,
    );
    await same(
      create("ct_ix3", {
        fields: [text("a")],
        indexes: [
          "CREATE INDEX a1 ON ct_ix3 (a)",
          "CREATE INDEX a2 ON ct_ix3 (a)",
        ],
      }),
      400,
    );
    await same(
      create("ct_ix4", {
        fields: [text("a")],
        indexes: [
          "CREATE INDEX idx_ct_all_x ON ct_ix4 (a)",
          "CREATE INDEX idx_ct_ix1 ON ct_ix4 (zzz)",
        ],
      }),
      400,
    );
    await same(
      create("ct_ix5", {
        type: "auth",
        indexes: ["CREATE INDEX ix5 ON ct_ix5 (email)"],
      }),
      200,
    );
    await same(
      create("ct_ix6", {
        fields: [text("a")],
        indexes: ["CREATE INDEX ix6 ON ct_ix6 (nope)"],
      }),
      400,
    );
  });
});

describe("authorization", () => {
  test("requests without a valid superuser token", async () => {
    for (const [method, path, body] of [
      ["GET", "/api/collections", undefined],
      ["GET", "/api/collections/users", undefined],
      ["POST", "/api/collections", { name: "ct_noauth" }],
      ["PATCH", "/api/collections/ct_min", { listRule: "" }],
      ["DELETE", "/api/collections/ct_min", undefined],
      ["DELETE", "/api/collections/ct_min/truncate", undefined],
      ["PUT", "/api/collections/import", { collections: [] }],
      ["GET", "/api/collections/meta/scaffolds", undefined],
    ] as const) {
      await same((t) => api(t, method, path, body, null), 401);
      await same((t) => api(t, method, path, body, "invalid"), 401);
    }
  });

  test("a superuser token on a base collection auth-refresh is forbidden", async () => {
    await same(create("ct_refresh"), 200);
    await same(
      (t) => api(t, "POST", "/api/collections/ct_refresh/auth-refresh"),
      403,
    );
  });
});

describe("scaffolds", () => {
  test("the body matches apart from the random id", async () => {
    const [pb, hb] = await both((t) =>
      api(t, "GET", "/api/collections/meta/scaffolds"),
    );
    const strip = (s: Snapshot) => {
      const body = s.body as Json;
      body.auth.indexes = body.auth.indexes.map((i: string) =>
        i.replace(/idx_(\w+?)_[a-z0-9]{10}/, "idx_$1_<random>"),
      );
      return s;
    };
    expect(pb.status).toBe(200);
    expectSame(strip(pb), strip(hb));
  });
});

describe("import", () => {
  const imported = [
    {
      name: "ct_imp_a",
      type: "base",
      fields: [text("title"), { name: "n", type: "number" }],
      listRule: "",
    },
    {
      name: "ct_imp_b",
      type: "auth",
      fields: [
        { name: "link", type: "relation", collectionId: "_pb_users_auth_" },
      ],
    },
  ];

  test("two collections, then an update without deleteMissing", async () => {
    await same(
      (t) =>
        api(t, "PUT", "/api/collections/import", { collections: imported }),
      204,
    );
    await same((t) => api(t, "GET", "/api/collections/ct_imp_a"), 200);
    await same((t) => api(t, "GET", "/api/collections/ct_imp_b"), 200);
    await same(
      (t) =>
        api(t, "PUT", "/api/collections/import", {
          collections: [{ name: "ct_imp_a", fields: [text("only")] }],
        }),
      204,
    );
    await same((t) => api(t, "GET", "/api/collections/ct_imp_a"), 200);
  });

  test("deleteMissing removes the other non-system collections", async () => {
    await same(
      (t) =>
        api(t, "PUT", "/api/collections/import", {
          collections: [{ name: "ct_imp_a" }],
          deleteMissing: true,
        }),
      204,
    );
    await same(
      (t) => api(t, "GET", "/api/collections?perPage=1000&sort=name"),
      200,
    );
  });

  test("a validation failure rolls everything back", async () => {
    await same(
      (t) =>
        api(t, "PUT", "/api/collections/import", {
          collections: [
            { name: "ct_imp_ok", fields: [text("a")] },
            { name: "ct_imp_bad", fields: [{ name: "s", type: "select" }] },
          ],
        }),
      400,
    );
    await same((t) => api(t, "GET", "/api/collections/ct_imp_ok"), 404);
  });

  test("invalid import bodies", async () => {
    await same(
      (t) => api(t, "PUT", "/api/collections/import", { collections: [] }),
      400,
    );
    await same((t) => api(t, "PUT", "/api/collections/import", {}), 400);
    await same(
      (t) => api(t, "PUT", "/api/collections/import", { collections: "x" }),
      400,
    );
    await same(
      (t) => api(t, "PUT", "/api/collections/import", { collections: [1] }),
      400,
    );
    await same(
      (t) =>
        api(t, "PUT", "/api/collections/import", {
          collections: [{}],
          deleteMissing: "x",
        }),
      400,
    );
    await same((t) => api(t, "PUT", "/api/collections/import", "{bad"), 400);
  });
});

describe("delete and truncate", () => {
  test("delete then view", async () => {
    await same(create("ct_del"), 200);
    await same((t) => api(t, "DELETE", "/api/collections/ct_del"), 204);
    await same((t) => api(t, "GET", "/api/collections/ct_del"), 404);
    await same((t) => api(t, "DELETE", "/api/collections/ct_del"), 404);
  });

  test("system collections cannot be deleted", async () => {
    await same((t) => api(t, "DELETE", "/api/collections/_superusers"), 400);
    await same((t) => api(t, "DELETE", "/api/collections/_mfas"), 400);
  });

  test("a referenced collection cannot be deleted", async () => {
    await same(create("ct_target"), 200);
    await same(
      (t) =>
        fetchJson(t, "/api/collections/ct_target").then((c) =>
          api(t, "POST", "/api/collections", {
            name: "ct_ref",
            fields: [
              {
                name: "to",
                type: "relation",
                collectionId: c.id,
                maxSelect: 1,
              },
            ],
          }),
        ),
      200,
    );
    await same((t) => api(t, "DELETE", "/api/collections/ct_target"), 400);
    await same((t) => api(t, "DELETE", "/api/collections/ct_ref"), 204);
    await same((t) => api(t, "DELETE", "/api/collections/ct_target"), 204);
  });

  test("truncate", async () => {
    await same(create("ct_trunc"), 200);
    await same(
      (t) => api(t, "DELETE", "/api/collections/ct_trunc/truncate"),
      204,
    );
    await same((t) => api(t, "DELETE", "/api/collections/nope/truncate"), 404);
    await same((t) => api(t, "DELETE", "/api/collections/_mfas/truncate"), 204);
  });
});

describe("collection form bodies", () => {
  const send = (
    method: string,
    path: string,
    entries: [string, string][],
    query = "",
  ) => {
    const form = new FormData();
    for (const [k, v] of entries) form.append(k, v);
    return (t: Target) =>
      fetch(`${t.url}${path}${query}`, {
        method,
        headers: { authorization: t.superToken },
        body: form,
      });
  };
  const post = (entries: [string, string][], query = "") =>
    send("POST", "/api/collections", entries, query);
  const manage: [string, string] = ["manageRule", "id != ''"];

  test("values bind as strings and null rules become empty", async () => {
    await same(post([["name", "123"]]), 200);
    await same(
      post(
        [
          ["name", "cf_base"],
          ["id", "cfbase000000001"],
          ["indexes", "CREATE INDEX idx_cf_base ON cf_base (id)"],
          ["system", "yes"],
        ],
        "?listRule=id%3D%27x%27",
      ),
      200,
    );
    await same(
      post([
        ["name", "cf_system"],
        ["Created.Updated.system", "1"],
      ]),
      200,
    );
    await same(
      send("PATCH", "/api/collections/cf_base", [["viewRule", "id != ''"]]),
      200,
    );
    await same(
      (t) =>
        fetch(`${t.url}/api/collections`, {
          method: "POST",
          headers: {
            authorization: t.superToken,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "name=cf_urlencoded&listRule=",
        }),
      200,
    );
  });

  test("auth options use PB's one-level key prefixes", async () => {
    await same(
      post([
        ["name", "cf_auth_blank"],
        ["type", "auth"],
      ]),
      400,
    );
    await same(
      post([
        ["name", "cf_auth"],
        ["type", "auth"],
        manage,
        ["otp.length", "0x8"],
        ["otp.enabled", "true"],
        ["authToken.duration", "1_000"],
        ["mfa.duration", "077"],
        ["mfa.rule", "id != ''"],
        ["emailTemplate.subject", "S"],
        ["mappedFields.enabled", "true"],
        ["oauth2.enabled", "false"],
        ["passwordAuth.identityFields", "email"],
        ["verificationTemplate.body", "B {{.ACTION_URL}}"],
        ["authAlert.enabled", "false"],
      ]),
      200,
    );
    await same(
      post([
        ["name", "cf_bad_int"],
        ["otp.length", "1e3"],
      ]),
      400,
    );
    await same(
      post([
        ["name", "cf_bad_bool"],
        ["Created.Updated.system", "yes"],
      ]),
      400,
    );
  });

  test("@jsonPayload is applied after the form values", async () => {
    await same(
      post([
        ["name", "cf_payload"],
        ["@jsonPayload", '{"listRule":null}'],
      ]),
      200,
    );
    await same(
      post([
        ["@jsonPayload", '{"name":"cf_payload_auth","type":"auth"}'],
        ["@jsonPayload", '{"manageRule":null}'],
      ]),
      200,
    );
    await same(
      post([
        ["name", "cf_view"],
        ["type", "view"],
      ]),
      400,
    );
    for (const payload of ["{", "[1]", '{"name":5}', '{"listRule":5}'])
      await same(
        post([
          ["name", "cf_bad"],
          ["@jsonPayload", payload],
        ]),
        400,
      );
  });

  test("a fields value is PB's 500", async () => {
    await same(
      post([
        ["name", "cf_fields"],
        ["fields", "x"],
      ]),
      500,
    );
    await same(post([["name", "cf_fields"]], "?fields=id"), 500);
  });

  test("quoted-printable parts are decoded", async () => {
    const body = [
      "--b",
      'Content-Disposition: form-data; name="name"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "cf=5Fq=",
      "p",
      "--b--",
      "",
    ].join("\r\n");
    await same(
      (t) =>
        fetch(`${t.url}/api/collections`, {
          method: "POST",
          headers: {
            authorization: t.superToken,
            "content-type": "multipart/form-data; boundary=b",
          },
          body,
        }),
      200,
    );
  });
});
