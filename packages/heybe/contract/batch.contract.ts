import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Snapshot,
  type Target,
  both,
  expectSame,
  startTargets,
} from "./harness";

let targets: Awaited<ReturnType<typeof startTargets>>;

type Json = Record<string, any>;

const FIXTURES = resolve(import.meta.dir, "../src/files/fixtures");
const fixture = (name: string) =>
  new File([Bun.file(join(FIXTURES, name))], `upload_${name}`);
// PB names batch uploads twice, so they get two random parts
const RANDOM_PART = /_[a-z0-9]{10}(?=[._])/g;
const collectionIds: Record<Target["name"], Record<string, string>> = {
  pocketbase: {},
  heybe: {},
};

const api = (
  t: Target,
  method: string,
  path: string,
  body?: Json | FormData,
  token: string | null = t.superToken,
) => {
  const json = body !== undefined && !(body instanceof FormData);
  return fetch(`${t.url}${path}`, {
    method,
    headers: {
      ...(json ? { "content-type": "application/json" } : {}),
      ...(token === null ? {} : { authorization: token }),
    },
    body: json ? JSON.stringify(body) : body,
  });
};

const batch = (t: Target, body: Json | FormData, token?: string | null) =>
  api(t, "POST", "/api/batch", body, token);

const maskNames = (value: unknown): unknown => {
  if (typeof value === "string") return value.replace(RANDOM_PART, "_<rand>");
  if (Array.isArray(value)) return value.map(maskNames);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, maskNames(v)]),
    );
  return value;
};

async function same(
  fn: (t: Target) => Promise<Response>,
  status: number,
): Promise<Snapshot> {
  const [pb, hb] = await both(fn);
  expect(pb.status).toBe(status);
  const masked = (s: Snapshot) => ({ ...s, body: maskNames(s.body) });
  expectSame(masked(pb), masked(hb));
  return pb;
}

async function setup(t: Target, method: string, path: string, body?: Json) {
  const res = await api(t, method, path, body);
  if (!res.ok) throw new Error(`${t.name} ${path}: ${await res.text()}`);
  return (await res.json()) as Json;
}

const settings = (batch: Json) =>
  Promise.all(
    [targets.pb, targets.hb].map((t) =>
      setup(t, "PATCH", "/api/settings", { batch }),
    ),
  );

const records = (c: string, rest = "") =>
  `/api/collections/${c}/records${rest}`;

function stored(t: Target, collection: string, recordId: string): string[] {
  const dir = join(
    t.dir,
    "storage",
    collectionIds[t.name][collection]!,
    recordId,
  );
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => !n.endsWith(".attrs"))
        .map((n) => n.replace(RANDOM_PART, "_<rand>"))
        .sort()
    : [];
}

const multipart = (requests: Json[], files: [string, File][]) => {
  const data = new FormData();
  data.append("@jsonPayload", JSON.stringify({ requests }));
  for (const [k, v] of files) data.append(k, v);
  return data;
};

beforeAll(async () => {
  targets = await startTargets();
  for (const t of [targets.pb, targets.hb]) {
    const tags = await setup(t, "POST", "/api/collections", {
      name: "tags",
      type: "base",
      listRule: "",
      viewRule: "",
      fields: [{ name: "name", type: "text" }],
    });
    const notes = await setup(t, "POST", "/api/collections", {
      name: "notes",
      type: "base",
      listRule: "",
      viewRule: "",
      createRule: '@request.body.title != "deny"',
      updateRule: "",
      deleteRule: "",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "views", type: "number" },
        {
          name: "tag",
          type: "relation",
          collectionId: tags.id,
          maxSelect: 1,
        },
        { name: "file", type: "file", maxSelect: 1 },
      ],
    });
    await setup(t, "POST", "/api/collections", {
      name: "locked",
      type: "base",
      fields: [{ name: "title", type: "text" }],
    });
    await setup(t, "POST", "/api/collections", {
      name: "notes_view",
      type: "view",
      viewQuery: "SELECT id, title FROM notes",
    });
    await setup(t, "POST", "/api/collections", {
      name: "members",
      type: "auth",
      createRule: "",
      viewRule: "id = @request.auth.id",
      updateRule: "id = @request.auth.id",
    });
    await setup(t, "POST", "/api/collections", {
      name: "gated",
      type: "base",
      viewRule: "",
      createRule: '@collection.notes.title ?= "open sesame"',
      fields: [{ name: "title", type: "text" }],
    });
    await setup(t, "POST", "/api/collections", {
      name: "secrets",
      type: "base",
      viewRule: "",
      createRule: "",
      fields: [
        { name: "title", type: "text" },
        { name: "secret", type: "text", hidden: true },
      ],
    });
    await setup(t, "POST", "/api/collections", {
      name: "managed",
      type: "auth",
      viewRule: "",
      createRule: "",
      manageRule: '@request.auth.collectionName = "members"',
    });
    await setup(t, "POST", records("members"), {
      id: "manager00000001",
      email: "manager@example.com",
      password: "1234567890",
      passwordConfirm: "1234567890",
    });
    collectionIds[t.name] = { tags: tags.id, notes: notes.id };
    await setup(t, "POST", records("tags"), {
      id: "tagtagtagtag001",
      name: "red",
    });
    await setup(t, "POST", records("notes"), {
      id: "seed00000000001",
      title: "seed",
    });
    await setup(t, "POST", records("locked"), {
      id: "lockedrec000001",
      title: "locked",
    });
  }
}, 60_000);

afterAll(async () => {
  await targets.stop();
});

describe("batch settings", () => {
  test("disabled by default", async () => {
    await same(
      (t) =>
        batch(t, {
          requests: [
            { method: "POST", url: records("notes"), body: { title: "x" } },
          ],
        }),
      403,
    );
  });

  test("body over maxBodySize", async () => {
    await settings({ enabled: true, maxRequests: 5, maxBodySize: 10 });
    try {
      await same(
        (t) =>
          batch(t, {
            requests: [
              { method: "POST", url: records("notes"), body: { title: "x" } },
            ],
          }),
        413,
      );
    } finally {
      await settings({ enabled: true, maxRequests: 5, maxBodySize: 0 });
    }
  });
});

describe("batch form", () => {
  test("missing requests", async () => {
    await same((t) => batch(t, {}), 400);
    await same((t) => batch(t, { requests: [] }), 400);
  });

  test("too many requests", async () => {
    const one = { method: "DELETE", url: records("notes", "/missing") };
    await same((t) => batch(t, { requests: Array(6).fill(one) }), 400);
  });

  test("invalid requests", async () => {
    await same(
      (t) =>
        batch(t, {
          requests: [
            {},
            { method: "GET", url: "/valid" },
            { method: "invalid", url: "/valid" },
            { method: "POST", url: "a".repeat(2001) },
          ],
        }),
      400,
    );
  });

  test("unreadable body", async () => {
    await same((t) => batch(t, { requests: "nope" }), 400);
    await same((t) => batch(t, { requests: [{ method: 1, url: "x" }] }), 400);
  });

  test("unsupported route inside the batch", async () => {
    await same(
      (t) => batch(t, { requests: [{ method: "GET", url: "/api/health" }] }),
      400,
    );
    await same(
      (t) =>
        batch(t, {
          requests: [
            { method: "POST", url: records("notes"), body: { title: "a" } },
            { method: "GET", url: records("notes") },
          ],
        }),
      400,
    );
  });
});

describe("batch writes", () => {
  test("create, update, upsert and delete in one transaction", async () => {
    await same(
      (t) =>
        batch(t, {
          requests: [
            {
              method: "POST",
              url: records("notes", "?expand=tag"),
              body: {
                id: "batchnote000001",
                title: "one",
                tag: "tagtagtagtag001",
              },
            },
            {
              method: "PATCH",
              url: records("notes", "/batchnote000001?fields=id,views"),
              body: { "views+": 2 },
            },
            {
              method: "PATCH",
              url: records("notes", "/batchnote000001"),
              body: { "views+": 3 },
            },
            {
              method: "PUT",
              url: records("notes"),
              body: { id: "batchnote000002", title: "two" },
            },
            {
              method: "PUT",
              url: records("notes", "?fields=id,title"),
              body: { id: "batchnote000001", title: "one upserted" },
            },
          ],
        }),
      200,
    );
    await same(
      (t) =>
        batch(t, {
          requests: [
            { method: "DELETE", url: records("notes", "/seed00000000001") },
            { method: "PUT", url: records("notes"), body: { title: "no id" } },
          ],
        }),
      200,
    );
    await same(
      (t) =>
        api(t, "GET", records("notes", "?sort=title&fields=id,title,views")),
      200,
    );
  });

  test("a failing request rolls back the earlier ones", async () => {
    const pb = await same(
      (t) =>
        batch(t, {
          requests: [
            {
              method: "POST",
              url: records("notes"),
              body: { id: "rollback0000001", title: "r" },
            },
            {
              method: "PATCH",
              url: records("notes", "/batchnote000002"),
              body: { title: "changed" },
            },
            { method: "POST", url: records("notes"), body: { title: "" } },
          ],
        }),
      400,
    );
    expect(pb.body).toMatchObject({ data: { requests: { 2: {} } } });
    await same((t) => api(t, "GET", records("notes", "/rollback0000001")), 404);
    await same(
      (t) => api(t, "GET", records("notes", "/batchnote000002?fields=title")),
      200,
    );
  });

  test("a missing record fails the batch", async () => {
    await same(
      (t) =>
        batch(t, {
          requests: [
            { method: "DELETE", url: records("notes", "/missing00000001") },
          ],
        }),
      400,
    );
  });

  test("missing and view collections fail the batch", async () => {
    for (const c of ["missing", "notes_view"])
      await same(
        (t) =>
          batch(t, {
            requests: [
              { method: "POST", url: records(c), body: { title: "x" } },
              {
                method: "DELETE",
                url: records(c, "/batchnote000001"),
              },
            ],
          }),
        400,
      );
  });
});

describe("batch rules", () => {
  test("guest passes the collection rules", async () => {
    await same(
      (t) =>
        batch(
          t,
          {
            requests: [
              {
                method: "POST",
                url: records("notes"),
                body: { id: "guestnote000001", title: "guest" },
              },
            ],
          },
          null,
        ),
      200,
    );
  });

  test("guest rule failure rolls back the batch", async () => {
    await same(
      (t) =>
        batch(
          t,
          {
            requests: [
              {
                method: "POST",
                url: records("notes"),
                body: { id: "guestnote000002", title: "guest" },
              },
              {
                method: "PATCH",
                url: records("locked", "/lockedrec000001"),
                body: { title: "x" },
                headers: { Authorization: t.superToken },
              },
            ],
          },
          null,
        ),
      400,
    );
    await same(
      (t) =>
        batch(
          t,
          {
            requests: [
              {
                method: "POST",
                url: records("notes"),
                body: { title: "deny" },
              },
            ],
          },
          null,
        ),
      400,
    );
    await same(
      (t) =>
        batch(
          t,
          {
            requests: [
              { method: "DELETE", url: records("locked", "/lockedrec000001") },
            ],
          },
          null,
        ),
      400,
    );
    await same((t) => api(t, "GET", records("notes", "/guestnote000002")), 404);
    await same(
      (t) => api(t, "GET", records("locked", "/lockedrec000001?fields=title")),
      200,
    );
  });
});

describe("multipart batch", () => {
  test("uploads files under requests.N keys", async () => {
    await same(
      (t) =>
        batch(
          t,
          multipart(
            [
              {
                method: "POST",
                url: records("notes"),
                body: { id: "multipart000001", title: "m1" },
              },
              {
                method: "POST",
                url: records("notes"),
                body: { id: "multipart000002", title: "m2" },
              },
            ],
            [
              ["requests.0.file", fixture("a.txt")],
              ["requests[1].file", fixture("a.png")],
            ],
          ),
        ),
      200,
    );
    for (const t of [targets.pb, targets.hb]) {
      expect(stored(t, "notes", "multipart000001")).toEqual([
        "upload_a_<rand>_<rand>.txt",
      ]);
      expect(stored(t, "notes", "multipart000002")).toEqual([
        "upload_a_<rand>_<rand>.png",
      ]);
    }
  });

  test("a failing multipart batch leaves no file in storage", async () => {
    await same(
      (t) =>
        batch(
          t,
          multipart(
            [
              {
                method: "POST",
                url: records("notes"),
                body: { id: "multipart000003", title: "m3" },
              },
              {
                method: "PATCH",
                url: records("notes", "/multipart000001"),
                body: { title: "m1 changed" },
              },
              { method: "POST", url: records("notes"), body: { title: "" } },
            ],
            [
              ["requests.0.file", fixture("a.txt")],
              ["requests.1.file", fixture("a.png")],
            ],
          ),
        ),
      400,
    );
    for (const t of [targets.pb, targets.hb]) {
      expect(stored(t, "notes", "multipart000003")).toEqual([]);
      expect(stored(t, "notes", "multipart000001")).toEqual([
        "upload_a_<rand>_<rand>.txt",
      ]);
    }
  });
});

describe("batch auth records", () => {
  const login = (t: Target, password: string) =>
    api(
      t,
      "POST",
      "/api/collections/members/auth-with-password",
      { identity: "member@example.com", password },
      null,
    );
  const token = async (t: Target, password: string) =>
    ((await (await login(t, password)).json()) as Json).token as string;
  const changePassword = (oldPassword: string) => async (t: Target) =>
    batch(
      t,
      {
        requests: [
          {
            method: "PATCH",
            url: records("members", "/member000000001"),
            body: {
              oldPassword,
              password: "abcdefghij",
              passwordConfirm: "abcdefghij",
            },
          },
        ],
      },
      await token(t, "1234567890"),
    );

  test("passwords are hashed and checked", async () => {
    await same(
      (t) =>
        batch(
          t,
          {
            requests: [
              {
                method: "POST",
                url: records("members"),
                body: {
                  id: "member000000001",
                  email: "member@example.com",
                  password: "1234567890",
                  passwordConfirm: "1234567890",
                },
              },
            ],
          },
          null,
        ),
      200,
    );
    await same((t) => login(t, "1234567890"), 200);
    await same(changePassword("wrong"), 400);
    await same(changePassword("1234567890"), 200);
    await same((t) => login(t, "abcdefghij"), 200);
  });
});

describe("batch request urls", () => {
  test("an unparsable url is an unknown action", async () => {
    await same(
      (t) => batch(t, { requests: [{ method: "POST", url: "http://[" }] }),
      400,
    );
    await same(
      (t) =>
        batch(t, {
          requests: [
            { method: "POST", url: records("notes"), body: { title: "u" } },
            { method: "PUT", url: "/api/collections/notes/records%" },
            { method: "POST", url: "http://[" },
          ],
        }),
      400,
    );
  });
});

describe("batch rules that depend on earlier writes", () => {
  const gated = (requests: Json[]) => (t: Target) =>
    batch(t, { requests }, null);
  const gatedCreate = (title: string) => ({
    method: "POST",
    url: records("gated"),
    body: { title },
  });

  test("a create rule passes only after an earlier write in the batch", async () => {
    await same(gated([gatedCreate("alone")]), 400);
    await same(
      gated([
        {
          method: "POST",
          url: records("notes"),
          body: { title: "open sesame" },
        },
        gatedCreate("after"),
      ]),
      200,
    );
  });
});

describe("batch response visibility", () => {
  const managerToken = async (t: Target) => {
    const res = await api(
      t,
      "POST",
      "/api/collections/members/auth-with-password",
      { identity: "manager@example.com", password: "1234567890" },
      null,
    );
    return ((await res.json()) as Json).token as string;
  };
  const createManaged = (email: string, extra: Json = {}) => ({
    method: "POST",
    url: records("managed"),
    body: {
      email,
      password: "1234567890",
      passwordConfirm: "1234567890",
      ...extra,
    },
  });

  test("hidden fields are dropped for guests and shown to superusers", async () => {
    const create = (id: string) => ({
      method: "POST",
      url: records("secrets"),
      body: { id, title: id, secret: "s" },
    });
    await same(
      (t) => batch(t, { requests: [create("secretguest0001")] }, null),
      200,
    );
    await same((t) => batch(t, { requests: [create("secretsuper0001")] }), 200);
    for (const id of ["secretguest0001", "secretsuper0001"])
      await same((t) => api(t, "GET", records("secrets", `/${id}`)), 200);
  });

  test("manage access shows the email and allows verified", async () => {
    await same(
      async (t) =>
        batch(
          t,
          {
            requests: [
              createManaged("managed1@example.com", { verified: true }),
            ],
          },
          await managerToken(t),
        ),
      200,
    );
    await same(
      (t) =>
        batch(
          t,
          {
            requests: [
              createManaged("managed2@example.com", { verified: true }),
            ],
          },
          null,
        ),
      400,
    );
    await same(
      (t) =>
        batch(t, { requests: [createManaged("managed3@example.com")] }, null),
      200,
    );
  });

  test("a superuser batch is blocked by the superuser IP allowlist", async () => {
    const both2 = (body: Json) =>
      Promise.all(
        [targets.pb, targets.hb].map((t) =>
          setup(t, "PATCH", "/api/settings", body),
        ),
      );
    await both2({
      trustedProxy: { headers: ["X-Forwarded-For"] },
      superuserIPs: ["127.0.0.1", "::1"],
    });
    try {
      await same(
        (t) =>
          fetch(`${t.url}/api/batch`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: t.superToken,
              "x-forwarded-for": "9.9.9.9",
            },
            body: JSON.stringify({
              requests: [
                {
                  method: "POST",
                  url: records("notes"),
                  body: { title: "ip" },
                },
              ],
            }),
          }),
        403,
      );
    } finally {
      await both2({ trustedProxy: { headers: [] }, superuserIPs: [] });
    }
  });
});
