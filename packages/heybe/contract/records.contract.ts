import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Snapshot,
  type Target,
  both,
  expectSame,
  startTargets,
} from "./harness";

let targets: Awaited<ReturnType<typeof startTargets>>;

type Json = Record<string, any>;

// per-target state: record ids and user tokens differ between PB and Heybe
const state: Record<Target["name"], Json> = { pocketbase: {}, heybe: {} };

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

async function same(
  fn: (t: Target) => Promise<Response>,
  status?: number,
): Promise<Snapshot> {
  const [pb, hb] = await both(fn);
  if (process.env.SHOW)
    console.log("STATUS", pb.status, JSON.stringify(pb.body).slice(0, 200));
  if (status !== undefined) expect(pb.status).toBe(status);
  expectSame(pb, hb);
  return pb;
}

async function remember(
  t: Target,
  key: string,
  res: Response,
  prop = "id",
): Promise<Response> {
  const body = (await res.clone().json()) as Json;
  state[t.name][key] = prop === "token" ? body.token : body[prop];
  return res;
}

const records = (c: string, query = "") =>
  `/api/collections/${c}/records${query}`;
const id = (t: Target, key: string) => state[t.name][key] as string;
const token = (t: Target, key: string) => state[t.name][key] as string;

const setRules = async (rules: Json) => {
  const [pb, hb] = await both((t) =>
    api(t, "PATCH", "/api/collections/posts", rules),
  );
  expect(pb.status).toBe(200);
  expect(hb.status).toBe(200);
};

const postsCount = async (t: Target) =>
  ((await (await api(t, "GET", records("posts"))).json()) as Json).totalItems;

beforeAll(async () => {
  targets = await startTargets();
  for (const t of [targets.pb, targets.hb]) {
    const res = await api(t, "POST", "/api/collections", {
      name: "posts",
      type: "base",
      listRule: "",
      viewRule: "",
      fields: [
        { name: "title", type: "text", required: true, max: 20 },
        {
          name: "status",
          type: "select",
          values: ["draft", "published"],
          maxSelect: 1,
        },
        { name: "views", type: "number", min: 0 },
        { name: "tags", type: "select", values: ["a", "b", "c"], maxSelect: 3 },
        {
          name: "author",
          type: "relation",
          collectionId: "_pb_users_auth_",
          maxSelect: 1,
        },
      ],
    });
    if (!res.ok) throw new Error(`${t.name}: ${await res.text()}`);
  }
}, 60_000);

afterAll(async () => {
  await targets.stop();
});

describe("users", () => {
  test("guest creates users (createRule empty)", async () => {
    for (const [key, email] of [
      ["u1", "Foo@x.com"],
      ["u2", "bar@x.com"],
    ]) {
      await same(
        (t) =>
          api(
            t,
            "POST",
            records("users"),
            {
              email,
              password: "12345678",
              passwordConfirm: "12345678",
              name: key,
            },
            null,
          ).then((r) => remember(t, key!, r)),
        200,
      );
    }
  });

  test("create without passwordConfirm", async () => {
    await same(
      (t) =>
        api(
          t,
          "POST",
          records("users"),
          { email: "c@x.com", password: "12345678" },
          null,
        ),
      400,
    );
  });

  test("guest cannot set verified", async () => {
    await same(
      (t) =>
        api(
          t,
          "POST",
          records("users"),
          {
            email: "v@x.com",
            password: "12345678",
            passwordConfirm: "12345678",
            verified: true,
          },
          null,
        ),
      400,
    );
  });

  test("email differing only by case", async () => {
    await same((t) =>
      api(
        t,
        "POST",
        records("users"),
        {
          email: "foo@x.com",
          password: "12345678",
          passwordConfirm: "12345678",
        },
        null,
      ),
    );
  });

  test("auth-with-password with the original and upper case email", async () => {
    for (const [key, identity] of [
      ["t1", "Foo@x.com"],
      ["t1upper", "FOO@X.COM"],
      ["t2", "bar@x.com"],
    ]) {
      await same((t) =>
        api(
          t,
          "POST",
          "/api/collections/users/auth-with-password",
          { identity, password: "12345678" },
          null,
        ).then((r) => remember(t, key!, r, "token")),
      );
    }
  });

  test("users list as a user only shows itself, with email", async () => {
    await same((t) =>
      api(t, "GET", records("users"), undefined, token(t, "t1")),
    );
  });

  test("users list as superuser shows all", async () => {
    await same((t) => api(t, "GET", records("users", "?sort=created")));
  });

  test("other user is not visible (view rule)", async () => {
    await same(
      (t) =>
        api(
          t,
          "GET",
          records("users", `/${id(t, "u2")}`),
          undefined,
          token(t, "t1"),
        ),
      404,
    );
  });
});

describe("superuser CRUD", () => {
  test("create", async () => {
    const bodies: [string, Json][] = [
      ["p1", { title: "first", status: "draft", views: 10, tags: ["a", "b"] }],
      ["p2", { title: "second", status: "published", views: 30, tags: ["c"] }],
      ["p3", { title: "third", status: "draft", views: 30, tags: [] }],
    ];
    for (const [key, body] of bodies) {
      await same(
        (t) =>
          api(t, "POST", records("posts"), {
            ...body,
            author: id(t, key === "p2" ? "u2" : "u1"),
          }).then((r) => remember(t, key, r)),
        200,
      );
    }
  });

  test("view", async () => {
    await same((t) => api(t, "GET", records("posts", `/${id(t, "p1")}`)), 200);
  });

  test("view missing", async () => {
    await same((t) => api(t, "GET", records("posts", "/missingid12345")), 404);
  });

  test("unknown collection", async () => {
    await same((t) => api(t, "GET", records("nope")), 404);
    await same((t) => api(t, "GET", records("nope", "/abc")), 404);
    await same((t) => api(t, "POST", records("nope"), { a: 1 }), 404);
    await same((t) => api(t, "PATCH", records("nope", "/abc"), { a: 1 }), 404);
    await same((t) => api(t, "DELETE", records("nope", "/abc")), 404);
  });

  test("update with modifiers", async () => {
    await same(
      (t) =>
        api(t, "PATCH", records("posts", `/${id(t, "p1")}`), {
          "views+": 5,
          "tags-": "a",
          title: "first!",
        }),
      200,
    );
  });

  test("list", async () => {
    await same((t) => api(t, "GET", records("posts")), 200);
  });

  test("list with filter, sort, fields, skipTotal", async () => {
    const q = new URLSearchParams({
      filter: "views >= 10 && status != ''",
      sort: "-views,title",
      fields: "id,title",
      skipTotal: "1",
    });
    await same((t) => api(t, "GET", records("posts", `?${q}`)), 200);
  });

  test("list with excerpt modifier", async () => {
    const q = new URLSearchParams({
      fields: "title:excerpt(3,true),views",
      sort: "title",
    });
    await same((t) => api(t, "GET", records("posts", `?${q}`)), 200);
  });

  test("invalid fields modifier", async () => {
    await same((t) =>
      api(
        t,
        "GET",
        records("posts", `/${id(t, "p1")}?fields=title:excerpt(0)`),
      ),
    );
    await same((t) =>
      api(t, "GET", records("posts", "?fields=title:excerpt(0)")),
    );
    await same((t) => api(t, "GET", records("posts", "?fields=title:nope(1)")));
  });

  test("validation errors on create", async () => {
    await same(
      (t) =>
        api(t, "POST", records("posts"), {
          title: "",
          status: "zzz",
          views: -1,
          tags: ["a", "x"],
          author: "missingid12345",
        }),
      400,
    );
  });

  test("validation errors on update", async () => {
    await same(
      (t) =>
        api(t, "PATCH", records("posts", `/${id(t, "p1")}`), {
          title: "x".repeat(30),
          status: "nope",
        }),
      400,
    );
  });

  test("delete and view after delete", async () => {
    await same(
      (t) =>
        api(t, "POST", records("posts"), { title: "temp" }).then((r) =>
          remember(t, "tmp", r),
        ),
      200,
    );
    await same(
      (t) => api(t, "DELETE", records("posts", `/${id(t, "tmp")}`)),
      204,
    );
    await same((t) => api(t, "GET", records("posts", `/${id(t, "tmp")}`)), 404);
    await same(
      (t) => api(t, "DELETE", records("posts", `/${id(t, "tmp")}`)),
      404,
    );
  });
});

describe("paging edges", () => {
  for (const q of [
    "perPage=0",
    "perPage=-5",
    "perPage=5000",
    "perPage=abc",
    "page=999",
    "page=0&perPage=1",
    "page=2&perPage=1&sort=title",
    "skipTotal=nope",
    "skipTotal=true&perPage=1",
  ]) {
    test(q, async () => {
      await same((t) => api(t, "GET", records("posts", `?${q}`)));
    });
  }
});

describe("untrusted filters", () => {
  for (const filter of [
    `title="x\\" || 1=1 --"`,
    "nope=1",
    `title="a"; DROP TABLE posts`,
    "views > 1 ||",
    `title ~ "%"`,
    "a".repeat(3501),
  ]) {
    test(filter.slice(0, 40), async () => {
      const q = new URLSearchParams({ filter });
      await same((t) => api(t, "GET", records("posts", `?${q}`)));
      await same((t) =>
        api(t, "GET", records("posts", `?${q}`), undefined, null),
      );
      const [pbCount, hbCount] = await Promise.all([
        postsCount(targets.pb),
        postsCount(targets.hb),
      ]);
      expect(pbCount).toBe(3);
      expect(hbCount).toBe(3);
    });
  }

  test("too many sort fields and too long sort field", async () => {
    const many = new URLSearchParams({ sort: "a,b,c,d,e,f,g,h,i" });
    await same((t) => api(t, "GET", records("posts", `?${many}`)), 400);
    const long = new URLSearchParams({ sort: "a".repeat(256) });
    await same((t) => api(t, "GET", records("posts", `?${long}`)), 400);
    await same((t) => api(t, "GET", records("posts", "?sort=nope")), 400);
  });

  test("@request and @collection in client filters are superuser only", async () => {
    for (const filter of [
      "@request.auth.id != ''",
      "@collection.users.id != ''",
    ]) {
      const q = new URLSearchParams({ filter });
      await same(
        (t) => api(t, "GET", records("posts", `?${q}`), undefined, null),
        403,
      );
      await same(
        (t) =>
          api(t, "GET", records("posts", `?${q}`), undefined, token(t, "t1")),
        403,
      );
      // without a sort, the DISTINCT over a join returns rows in (random) id order
      const sorted = new URLSearchParams({ filter, sort: "title" });
      await same((t) => api(t, "GET", records("posts", `?${sorted}`)), 200);
    }
    const q = new URLSearchParams({ sort: "@request.auth.id" });
    await same(
      (t) => api(t, "GET", records("posts", `?${q}`), undefined, null),
      403,
    );
  });
});

describe("rules", () => {
  test("listRule null: guest is forbidden, superuser allowed", async () => {
    await setRules({ listRule: null });
    await same((t) => api(t, "GET", records("posts"), undefined, null), 403);
    await same((t) => api(t, "GET", records("posts")), 200);
  });

  test('listRule "": guest sees all', async () => {
    await setRules({ listRule: "" });
    await same((t) => api(t, "GET", records("posts"), undefined, null), 200);
  });

  test("listRule owner filter as two users and guest", async () => {
    await setRules({ listRule: "author = @request.auth.id" });
    await same(
      (t) => api(t, "GET", records("posts"), undefined, token(t, "t1")),
      200,
    );
    await same(
      (t) => api(t, "GET", records("posts"), undefined, token(t, "t2")),
      200,
    );
    await same((t) => api(t, "GET", records("posts"), undefined, null), 200);
    const q = new URLSearchParams({ filter: "views > 10" });
    await same(
      (t) =>
        api(t, "GET", records("posts", `?${q}`), undefined, token(t, "t1")),
      200,
    );
  });

  test("viewRule failure is 404, success 200, null rule 403", async () => {
    await setRules({ viewRule: "author = @request.auth.id" });
    await same(
      (t) =>
        api(
          t,
          "GET",
          records("posts", `/${id(t, "p2")}`),
          undefined,
          token(t, "t1"),
        ),
      404,
    );
    await same(
      (t) =>
        api(
          t,
          "GET",
          records("posts", `/${id(t, "p1")}`),
          undefined,
          token(t, "t1"),
        ),
      200,
    );
    await setRules({ viewRule: null });
    await same(
      (t) =>
        api(
          t,
          "GET",
          records("posts", `/${id(t, "p1")}`),
          undefined,
          token(t, "t1"),
        ),
      403,
    );
  });

  test("createRule on the request body", async () => {
    await setRules({ createRule: "@request.body.status = 'draft'" });
    await same(
      (t) =>
        api(
          t,
          "POST",
          records("posts"),
          { title: "ok", status: "draft" },
          token(t, "t1"),
        ).then((r) => remember(t, "p4", r)),
      200,
    );
    await same(
      (t) =>
        api(
          t,
          "POST",
          records("posts"),
          { title: "no", status: "published" },
          token(t, "t1"),
        ),
      400,
    );
    await same(
      (t) => api(t, "POST", records("posts"), { title: "no" }, null),
      400,
    );
    await setRules({ createRule: null });
    await same(
      (t) => api(t, "POST", records("posts"), { title: "no" }, null),
      403,
    );
  });

  test("createRule using the new record fields", async () => {
    await setRules({ createRule: "author = @request.auth.id && views < 5" });
    await same(
      (t) =>
        api(
          t,
          "POST",
          records("posts"),
          { title: "mine", author: id(t, "u1"), views: 1 },
          token(t, "t1"),
        ).then((r) => remember(t, "p5", r)),
      200,
    );
    await same(
      (t) =>
        api(
          t,
          "POST",
          records("posts"),
          { title: "theirs", author: id(t, "u2") },
          token(t, "t1"),
        ),
      400,
    );
  });

  test("updateRule and deleteRule failures are 404", async () => {
    await setRules({
      updateRule: "author = @request.auth.id",
      deleteRule: "author = @request.auth.id",
    });
    await same(
      (t) =>
        api(
          t,
          "PATCH",
          records("posts", `/${id(t, "p2")}`),
          { title: "hack" },
          token(t, "t1"),
        ),
      404,
    );
    await same(
      (t) =>
        api(
          t,
          "DELETE",
          records("posts", `/${id(t, "p2")}`),
          undefined,
          token(t, "t1"),
        ),
      404,
    );
    await same(
      (t) =>
        api(
          t,
          "PATCH",
          records("posts", `/${id(t, "p5")}`),
          { title: "edited" },
          token(t, "t1"),
        ),
      200,
    );
    await same(
      (t) =>
        api(
          t,
          "DELETE",
          records("posts", `/${id(t, "p5")}`),
          undefined,
          token(t, "t1"),
        ),
      204,
    );
  });

  test("updateRule on the new body value", async () => {
    await setRules({ updateRule: "@request.body.views:isset = false" });
    await same(
      (t) =>
        api(
          t,
          "PATCH",
          records("posts", `/${id(t, "p4")}`),
          { views: 3 },
          token(t, "t1"),
        ),
      404,
    );
    await same(
      (t) =>
        api(
          t,
          "PATCH",
          records("posts", `/${id(t, "p4")}`),
          { title: "t" },
          token(t, "t1"),
        ),
      200,
    );
  });

  test("null update and delete rules are superuser only", async () => {
    await setRules({ updateRule: null, deleteRule: null });
    await same(
      (t) =>
        api(
          t,
          "PATCH",
          records("posts", `/${id(t, "p4")}`),
          {},
          token(t, "t1"),
        ),
      403,
    );
    await same(
      (t) =>
        api(t, "DELETE", records("posts", `/${id(t, "p4")}`), undefined, null),
      403,
    );
  });
});

describe("required references and truncate", () => {
  test("deleting a record referenced by a required relation", async () => {
    for (const t of [targets.pb, targets.hb]) {
      const res = await api(t, "POST", "/api/collections", {
        name: "comments",
        type: "base",
        fields: [
          {
            name: "post",
            type: "relation",
            required: true,
            collectionId: (
              await (await api(t, "GET", "/api/collections/posts")).json()
            ).id,
            maxSelect: 1,
          },
        ],
      });
      if (!res.ok) throw new Error(`${t.name}: ${await res.text()}`);
    }
    await same(
      (t) => api(t, "POST", records("comments"), { post: id(t, "p3") }),
      200,
    );
    await same(
      (t) => api(t, "DELETE", records("posts", `/${id(t, "p3")}`)),
      400,
    );
  });

  test("truncate a collection holding records", async () => {
    await same(
      (t) => api(t, "DELETE", "/api/collections/comments/truncate"),
      204,
    );
    await same((t) => api(t, "GET", records("comments")), 200);
    const [pb] = await both((t) => api(t, "GET", records("comments")));
    expect((pb.body as Json).totalItems).toBe(0);
  });
});

describe("password change", () => {
  test("owner must send oldPassword", async () => {
    await same(
      (t) =>
        api(
          t,
          "PATCH",
          records("users", `/${id(t, "u1")}`),
          { password: "87654321", passwordConfirm: "87654321" },
          token(t, "t1"),
        ),
      400,
    );
    await same(
      (t) =>
        api(
          t,
          "PATCH",
          records("users", `/${id(t, "u1")}`),
          {
            password: "87654321",
            passwordConfirm: "87654321",
            oldPassword: "wrong",
          },
          token(t, "t1"),
        ),
      400,
    );
  });

  test("owner cannot change email without manage access", async () => {
    await same(
      (t) =>
        api(
          t,
          "PATCH",
          records("users", `/${id(t, "u1")}`),
          { email: "new@x.com" },
          token(t, "t1"),
        ),
      400,
    );
  });

  test("old token is rejected after password change", async () => {
    await same(
      (t) =>
        api(
          t,
          "PATCH",
          records("users", `/${id(t, "u1")}`),
          {
            password: "87654321",
            passwordConfirm: "87654321",
            oldPassword: "12345678",
          },
          token(t, "t1"),
        ),
      200,
    );
    await same(
      (t) =>
        api(
          t,
          "POST",
          "/api/collections/users/auth-refresh",
          undefined,
          token(t, "t1"),
        ),
      401,
    );
    await same(
      (t) =>
        api(
          t,
          "POST",
          "/api/collections/users/auth-with-password",
          { identity: "Foo@x.com", password: "87654321" },
          null,
        ),
      200,
    );
  });
});

describe("hidden fields", () => {
  test("hidden fields are dropped for guests and usable in rules", async () => {
    await same(async (t) => {
      const posts = await (
        await api(t, "GET", "/api/collections/posts")
      ).json();
      return api(t, "PATCH", "/api/collections/posts", {
        fields: [
          ...posts.fields,
          { name: "secret", type: "text", hidden: true },
          { name: "body", type: "text" },
        ],
        listRule: "secret = ''",
        viewRule: "",
        createRule: "",
      });
    }, 200);
  });

  test("guest create ignores the hidden field", async () => {
    await same(
      (t) =>
        api(
          t,
          "POST",
          records("posts"),
          {
            title: "guest",
            secret: "s",
            body: "<p>Hello <b>big</b> world</p>",
          },
          null,
        ).then((r) => remember(t, "g1", r)),
      200,
    );
    await same((t) => api(t, "GET", records("posts", `/${id(t, "g1")}`)), 200);
  });

  test("guest cannot filter or sort by a hidden field", async () => {
    await same(
      (t) =>
        api(t, "GET", records("posts", "?filter=secret%3D''"), undefined, null),
      400,
    );
    await same(
      (t) => api(t, "GET", records("posts", "?sort=secret"), undefined, null),
      400,
    );
  });

  test("superuser sets the hidden field, list rule hides it from guests", async () => {
    await same(
      (t) =>
        api(t, "PATCH", records("posts", `/${id(t, "g1")}`), { secret: "x" }),
      200,
    );
    await same(
      (t) => api(t, "GET", records("posts", "?sort=title"), undefined, null),
      200,
    );
  });

  test("excerpt of html", async () => {
    for (const fields of [
      "body:excerpt(9,true)",
      "body:excerpt(100)",
      "*,body:excerpt(5,1)",
    ]) {
      const q = new URLSearchParams({ fields });
      await same(
        (t) => api(t, "GET", records("posts", `/${id(t, "g1")}?${q}`)),
        200,
      );
    }
  });
});

describe("manage rule", () => {
  test("a manager changes email and password without oldPassword", async () => {
    await same(
      (t) =>
        api(t, "PATCH", "/api/collections/users", {
          manageRule: "id = @request.auth.id",
        }),
      200,
    );
    await same(
      (t) =>
        api(
          t,
          "POST",
          "/api/collections/users/auth-with-password",
          { identity: "bar@x.com", password: "12345678" },
          null,
        ).then((r) => remember(t, "t2", r, "token")),
      200,
    );
    await same(
      (t) =>
        api(
          t,
          "PATCH",
          records("users", `/${id(t, "u2")}`),
          {
            email: "bar2@x.com",
            password: "abcdefgh",
            passwordConfirm: "abcdefgh",
          },
          token(t, "t2"),
        ),
      200,
    );
  });
});

describe("request info in rules", () => {
  test("headers, query, method and context", async () => {
    await setRules({
      listRule:
        "@request.headers.x_api_key = 'k' && @request.query.flag = '1' && @request.method = 'GET' && @request.context = 'default'",
    });
    const list = (headers: Record<string, string>, query: string) =>
      both((t) =>
        fetch(`${t.url}${records("posts", query)}`, { headers }).then((r) => r),
      );
    const counts: number[] = [];
    for (const [headers, query] of [
      [{ "X-Api-Key": "k" }, "?flag=1&sort=title"],
      [{ "x-api-key": "k" }, "?flag=1&flag=2&sort=title"],
      [{ "X-Api-Key": "other" }, "?flag=1"],
      [{}, "?flag=1"],
    ] as const) {
      const [pb, hb] = await list(headers, query);
      expectSame(pb, hb);
      counts.push((pb.body as Json).totalItems);
    }
    expect(counts.map((n) => n > 0)).toEqual([true, true, false, false]);
  });

  test("body modifiers in create and update rules", async () => {
    await setRules({
      createRule:
        "@request.body.views:isset = true && @request.body.tags:length > 1 && @request.body.views > 2",
      updateRule: "@request.body.title:changed = false",
    });
    for (const body of [
      { title: "r1", views: 3, tags: ["a", "b"] },
      { title: "r2", views: 3, tags: ["a"] },
      { title: "r3", "views+": 3, tags: ["a", "b"] },
      { title: "r4", tags: ["a", "b"] },
    ]) {
      await same((t) =>
        api(t, "POST", records("posts"), body, token(t, "t2")).then((r) =>
          r.status === 200 ? remember(t, body.title, r) : r,
        ),
      );
    }
    await same((t) =>
      api(
        t,
        "PATCH",
        records("posts", `/${id(t, "r1")}`),
        { title: "r1" },
        null,
      ),
    );
    await same((t) =>
      api(
        t,
        "PATCH",
        records("posts", `/${id(t, "r1")}`),
        { title: "zz" },
        null,
      ),
    );
  });

  test("a rule failing in SQLite", async () => {
    await setRules({ updateRule: "@request.body.tags:each ~ 'a'" });
    await same((t) =>
      api(
        t,
        "PATCH",
        records("posts", `/${id(t, "r1")}`),
        { tags: ["a", "b"] },
        null,
      ),
    );
  });

  test("invalid json body", async () => {
    await same((t) => api(t, "POST", records("posts"), "{nope"), 400);
    await same((t) =>
      api(t, "PATCH", records("posts", `/${id(t, "r1")}`), "[1]"),
    );
  });

  test("create with an explicit id", async () => {
    await same(
      (t) =>
        api(t, "POST", records("posts"), { id: "myid12345678901", title: "x" }),
      200,
    );
    await same(
      (t) =>
        api(t, "POST", records("posts"), { id: "myid12345678901", title: "x" }),
      400,
    );
  });
});

describe("protected fields from non-superusers", () => {
  const stamp = "2000-01-01 00:00:00.000Z";
  const raw = async (t: Target, path: string) =>
    (await (await api(t, "GET", path)).json()) as Json;

  test("setup: public create and update rules, no manage rule", async () => {
    await same(
      (t) =>
        api(t, "PATCH", "/api/collections/users", {
          manageRule: null,
          updateRule: "",
        }),
      200,
    );
    await setRules({ createRule: "", updateRule: "" });
  });

  test("tokenKey, created and updated on auth create", async () => {
    await same(
      (t) =>
        api(
          t,
          "POST",
          records("users"),
          {
            email: "pf@x.com",
            password: "12345678",
            passwordConfirm: "12345678",
            tokenKey: "attackerchosenkey1234567890",
            created: stamp,
            updated: stamp,
          },
          null,
        ).then((r) => remember(t, "pf", r)),
      200,
    );
    await same(
      (t) =>
        api(
          t,
          "POST",
          "/api/collections/users/auth-with-password",
          { identity: "pf@x.com", password: "12345678" },
          null,
        ).then((r) => remember(t, "pfToken", r, "token")),
      200,
    );
    for (const t of [targets.pb, targets.hb]) {
      const r = await raw(t, records("users", `/${id(t, "pf")}`));
      expect(r.created).not.toBe(stamp);
      expect(r.updated).not.toBe(stamp);
    }
  });

  test("tokenKey, created and updated on auth update", async () => {
    await same((t) =>
      api(
        t,
        "PATCH",
        records("users", `/${id(t, "pf")}`),
        {
          tokenKey: "attackerchosenkey1234567890",
          created: stamp,
          updated: stamp,
          name: "renamed",
        },
        null,
      ),
    );
    // the token stays valid only when tokenKey was not replaced
    await same(
      (t) =>
        api(
          t,
          "POST",
          "/api/collections/users/auth-refresh",
          undefined,
          token(t, "pfToken"),
        ),
      200,
    );
    for (const t of [targets.pb, targets.hb]) {
      const r = await raw(t, records("users", `/${id(t, "pf")}`));
      expect(r.created).not.toBe(stamp);
      expect(r.updated).not.toBe(stamp);
    }
  });

  test("changed id on update", async () => {
    for (const [c, key] of [
      ["users", "pf"],
      ["posts", "r1"],
    ]) {
      await same((t) =>
        api(
          t,
          "PATCH",
          records(c!, `/${id(t, key!)}`),
          { id: "changedid123456" },
          null,
        ),
      );
      await same((t) => api(t, "GET", records(c!, `/${id(t, key!)}`)), 200);
      await same((t) => api(t, "GET", records(c!, "/changedid123456")), 404);
    }
  });

  test("created and updated on base create and update", async () => {
    await same(
      (t) =>
        api(
          t,
          "POST",
          records("posts"),
          { title: "stamped", created: stamp, updated: stamp },
          null,
        ).then((r) => remember(t, "stamped", r)),
      200,
    );
    await same((t) =>
      api(
        t,
        "PATCH",
        records("posts", `/${id(t, "stamped")}`),
        { created: stamp, updated: stamp },
        null,
      ),
    );
    for (const t of [targets.pb, targets.hb]) {
      const r = await raw(t, records("posts", `/${id(t, "stamped")}`));
      expect(r.created).not.toBe(stamp);
      expect(r.updated).not.toBe(stamp);
    }
  });
});
