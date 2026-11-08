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
      ...(body === undefined || body instanceof FormData
        ? {}
        : { "content-type": "application/json" }),
      ...(token === null ? {} : { authorization: token }),
    },
    body:
      body === undefined || body instanceof FormData
        ? (body as FormData | undefined)
        : JSON.stringify(body),
  });

// uploaded file names end with a random part
const RANDOM_PART = /_[a-z0-9]{10}(?=\.)/g;
// dry-run samples belong to a randomly named temp collection
const TEMP = /^(temp_view_\w{5}|pbc_\d+)$/;

const mask = (value: unknown, key = ""): unknown => {
  if (typeof value === "string") {
    if (
      (key === "collectionName" || key === "collectionId") &&
      TEMP.test(value)
    )
      return "<temp>";
    return value.replace(RANDOM_PART, "_<rand>");
  }
  if (Array.isArray(value)) return value.map((v) => mask(v, key));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, mask(v, k)]),
    );
  return value;
};

async function same(
  fn: (t: Target) => Promise<Response>,
  status = 200,
  headers?: string[],
): Promise<Snapshot> {
  const [pb, hb] = await both(fn, { headers });
  expect(pb.status).toBe(status);
  const masked = (s: Snapshot) => ({
    ...s,
    headers: mask(s.headers) as Snapshot["headers"],
    body: mask(s.body),
  });
  expectSame(masked(pb), masked(hb));
  return pb;
}

async function setup(t: Target, method: string, path: string, body?: unknown) {
  const res = await api(t, method, path, body);
  if (!res.ok) throw new Error(`${t.name} ${path}: ${await res.text()}`);
  return res.status === 204 ? {} : ((await res.json()) as Json);
}

const collections = "/api/collections";
const records = (c: string, rest = "") => `${collections}/${c}/records${rest}`;
const dryRun = (query: unknown) => (t: Target) =>
  api(t, "POST", `${collections}/meta/dry-run-view`, { query });
const createView =
  (name: string, viewQuery: string, extra: Json = {}) =>
  (t: Target) =>
    api(t, "POST", collections, { name, type: "view", viewQuery, ...extra });

const fileNames: Record<Target["name"], string> = {
  pocketbase: "",
  heybe: "",
};

const STATS = `select p.id, p.title, p.title as heading, p.author, p.secret,
  (p.views + 1) as bumped, cast(p.views as int) as views_int,
  count(p.id) as total, p.id as post
from posts p
group by p.id`;

beforeAll(async () => {
  targets = await startTargets();
  for (const t of [targets.pb, targets.hb]) {
    const authors = await setup(t, "POST", collections, {
      name: "authors",
      listRule: "",
      viewRule: "",
      fields: [{ name: "name", type: "text" }],
    });
    await setup(t, "POST", collections, {
      name: "posts",
      listRule: "",
      viewRule: "",
      fields: [
        { name: "title", type: "text" },
        { name: "views", type: "number" },
        {
          name: "author",
          type: "relation",
          collectionId: authors.id,
          maxSelect: 1,
        },
        { name: "secret", type: "text", hidden: true },
        { name: "doc", type: "file", maxSelect: 1 },
      ],
    });
    await setup(t, "POST", collections, {
      name: "tags",
      fields: [{ name: "name", type: "text" }],
    });
    for (const [id, name] of [
      ["author000000001", "Ann"],
      ["author000000002", "Bob"],
    ])
      await setup(t, "POST", records("authors"), { id, name });
    const doc = new FormData();
    for (const [k, v] of Object.entries({
      id: "post00000000001",
      title: "alpha",
      views: "3",
      author: "author000000001",
      secret: "s1",
    }))
      doc.append(k, v);
    doc.append("doc", new File(["hello view"], "hello.txt"));
    const p1 = await setup(t, "POST", records("posts"), doc);
    fileNames[t.name] = p1.doc;
    await setup(t, "POST", records("posts"), {
      id: "post00000000002",
      title: "beta",
      views: 0,
      author: "author000000002",
    });
    await setup(t, "POST", records("posts"), {
      id: "post00000000003",
      title: "gamma",
      views: 10,
      author: "author000000001",
    });
    await setup(t, "POST", records("tags"), {
      id: "tag000000000001",
      name: "red",
    });
  }
}, 30_000);

afterAll(async () => {
  await targets?.stop();
});

describe("create", () => {
  test("inferred fields equal PB's", async () => {
    await same(createView("post_stats", STATS, { listRule: "" }));
    await same((t) => api(t, "GET", `${collections}/post_stats`));
  });

  test("files, nested view and dependency views", async () => {
    await same(
      createView("post_files", "select id, doc, title from posts", {
        listRule: "",
        viewRule: "",
      }),
    );
    await same(
      createView("nested_files", "select id, doc as file from post_files", {
        viewRule: "",
      }),
    );
    await same(createView("tag_names", "select id, name from tags"));
  });

  test.each([
    ["no id", "select title from posts"],
    ["two statements", "select id from posts; select id from tags"],
    ["delete", "delete from posts"],
    ["unknown table", "select id from missing"],
    ["unknown column", "select id, nope from posts"],
    ["wildcard", "select * from posts"],
    ["invalid alias", "select id, 1 as expand from posts"],
    ["unbalanced", "select id, (title from posts"],
    ["empty", ""],
  ])("invalid query: %s", async (_, query) => {
    await same(createView("bad_view", query), 400);
  });

  test("write rules and indexes are not allowed", async () => {
    await same(
      createView("bad_view", "select id from posts", {
        createRule: "",
        indexes: ["create index idx_bad on bad_view (id)"],
      }),
      400,
    );
  });
});

describe("records", () => {
  test("list with sort and filter", async () => {
    await same((t) => api(t, "GET", records("post_stats", "?sort=-title")));
    await same((t) =>
      api(
        t,
        "GET",
        records(
          "post_stats",
          `?filter=${encodeURIComponent("views_int > 2 && title ~ 'a'")}&sort=-views_int`,
        ),
      ),
    );
    await same((t) =>
      api(t, "GET", records("post_stats", "?sort=heading&perPage=1&page=2")),
    );
  });

  test("expand through inferred relations", async () => {
    await same((t) =>
      api(t, "GET", records("post_stats", "?sort=title&expand=author,post")),
    );
    await same((t) =>
      api(
        t,
        "GET",
        records("post_stats", "/post00000000001?expand=author,post.author"),
      ),
    );
  });

  test("view rule", async () => {
    await same((t) =>
      api(t, "GET", records("post_stats", "?sort=title"), undefined, null),
    );
    await same(
      (t) =>
        api(
          t,
          "GET",
          records("post_stats", "/post00000000001"),
          undefined,
          null,
        ),
      403,
    );
  });

  test.each([
    ["create", "POST", ""],
    ["update", "PATCH", "/post00000000001"],
    ["delete", "DELETE", "/post00000000001"],
  ])("%s is unsupported", async (_, method, rest) => {
    await same(
      (t) =>
        api(
          t,
          method,
          records("post_stats", rest),
          method === "DELETE" ? undefined : { title: "x" },
        ),
      400,
    );
  });
});

describe("files", () => {
  const download =
    (view: string, field: (t: Target) => string) => (t: Target) =>
      fetch(`${t.url}/api/files/${view}/post00000000001/${field(t)}`);

  test("served from the source record", async () => {
    await same(
      download("post_files", (t) => fileNames[t.name]),
      200,
      ["content-disposition"],
    );
    await same(
      download("nested_files", (t) => fileNames[t.name]),
      200,
      ["content-disposition"],
    );
    await same(
      download("post_files", () => "missing.txt"),
      404,
    );
  });
});

describe("dry-run-view", () => {
  test("returns fields and a sample", async () => {
    await same(dryRun("select id, title, views from posts order by title"));
    await same(
      dryRun(
        "select (ROW_NUMBER() OVER()) as id, author, count(id) as n from posts group by author order by author",
      ),
    );
  });

  test.each([
    ["required", ""],
    ["not a string", 1],
    ["too long", "a".repeat(5001)],
    ["no id", "select title from posts"],
    ["wildcard", "select * from posts"],
    ["empty ids", "select null as id from posts"],
    ["duplicate ids", "select 'x' as id from posts"],
    ["invalid field name", 'select id, 1 as "my col" from posts'],
  ])("%s", async (_, query) => {
    await same(dryRun(query), 400);
  });

  test("requires a superuser", async () => {
    await same(
      (t) =>
        api(
          t,
          "POST",
          `${collections}/meta/dry-run-view`,
          { query: "select id from posts" },
          null,
        ),
      401,
    );
  });
});

describe("hostile queries", () => {
  const hostile = [
    "select id from posts; drop table posts",
    "select id from posts; drop table posts;",
    "select 1 as id; attach database ':memory:' as x",
    "attach database 'x.db' as x",
    "with x as (delete from posts returning id) select id from x",
    "pragma table_info(posts)",
    "select 1 as id /* ; drop table posts */",
    "select 1 as id -- ; drop table posts",
    "select 1 as id /* ' */); drop table posts; select (1 /* ' */",
  ];

  test.each(hostile)("dry-run: %s", async (query) => {
    await same(dryRun(query), 400);
  });

  test.each(hostile)("create: %s", async (query) => {
    await same(createView("evil_view", query), 400);
  });

  test("nothing changed", async () => {
    await same((t) => api(t, "GET", records("posts", "?sort=id")));
    await same((t) =>
      api(
        t,
        "GET",
        `${collections}?filter=${encodeURIComponent("system = false")}&sort=name&fields=name,type`,
      ),
    );
  });
});

describe("source collections", () => {
  test("a field read by a view cannot be removed", async () => {
    await same(async (t) => {
      const tags = await setup(t, "GET", `${collections}/tags`);
      return api(t, "PATCH", `${collections}/tags`, {
        fields: tags.fields.filter((f: Json) => f.name !== "name"),
      });
    }, 400);
    await same((t) => api(t, "GET", records("tag_names")));
  });

  test("a collection read by a view cannot be deleted", async () => {
    await same((t) => api(t, "DELETE", `${collections}/tags`), 400);
    await same((t) => api(t, "GET", `${collections}/tags`, undefined));
  });

  test("a relation inferred by a view blocks the delete", async () => {
    await same((t) => api(t, "DELETE", `${collections}/posts`), 400);
  });

  test("changing the query recreates the view", async () => {
    await same((t) =>
      api(t, "PATCH", `${collections}/tag_names`, {
        viewQuery: "select id, upper(name) as label from tags",
      }),
    );
    await same((t) => api(t, "GET", records("tag_names")));
  });

  test("the source is free once the view is gone", async () => {
    await same((t) => api(t, "DELETE", `${collections}/tag_names`), 204);
    await same((t) => api(t, "DELETE", `${collections}/tags`), 204);
  });
});
