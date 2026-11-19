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

// per-target record ids: they differ between PB and Heybe
const ids: Record<Target["name"], Record<string, string>> = {
  pocketbase: {},
  heybe: {},
};

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

async function same(
  fn: (t: Target) => Promise<Response>,
  status = 200,
): Promise<Snapshot> {
  const [pb, hb] = await both(fn);
  expect(pb.status).toBe(status);
  expectSame(pb, hb);
  return pb;
}

const records = (c: string, rest = "") =>
  `/api/collections/${c}/records${rest}`;
const id = (t: Target, key: string) => ids[t.name][key]!;
const guestGet = (path: (t: Target) => string) => (t: Target) =>
  api(t, "GET", path(t), undefined, null);

async function setup(t: Target, method: string, path: string, body: unknown) {
  const res = await api(t, method, path, body);
  if (!res.ok) throw new Error(`${t.name} ${path}: ${await res.text()}`);
  return (await res.json()) as Json;
}

const rel = (
  name: string,
  collectionId: string,
  maxSelect = 1,
  extra = {},
) => ({
  name,
  type: "relation",
  collectionId,
  maxSelect,
  ...extra,
});
const open = { listRule: "", viewRule: "" };

beforeAll(async () => {
  targets = await startTargets();
  for (const t of [targets.pb, targets.hb]) {
    const c = "/api/collections";
    const authors = await setup(t, "POST", c, {
      name: "authors",
      ...open,
      fields: [{ name: "name", type: "text" }],
    });
    const secrets = await setup(t, "POST", c, {
      name: "secrets",
      fields: [{ name: "name", type: "text" }],
    });
    const members = await setup(t, "POST", c, {
      name: "members",
      type: "auth",
      ...open,
      createRule: "",
      fields: [
        { name: "name", type: "text" },
        { name: "note", type: "text", hidden: true },
        rel("favorite", authors.id),
      ],
    });
    const posts = await setup(t, "POST", c, {
      name: "posts",
      ...open,
      createRule: "",
      updateRule: "",
      fields: [
        { name: "title", type: "text" },
        rel("author", authors.id),
        rel("tags", authors.id, 5),
        rel("secret", secrets.id),
        rel("editor", authors.id, 1, { hidden: true }),
      ],
    });
    await setup(t, "PATCH", `${c}/posts`, {
      fields: [...posts.fields, rel("parent", posts.id)],
    });
    await setup(t, "POST", c, {
      name: "comments",
      ...open,
      fields: [
        { name: "message", type: "text" },
        rel("post", posts.id),
        rel("user", members.id),
      ],
    });
    await setup(t, "POST", c, {
      name: "likes",
      ...open,
      fields: [rel("posts", posts.id, 5)],
    });
    await setup(t, "POST", c, {
      name: "profiles",
      ...open,
      fields: [{ name: "bio", type: "text" }, rel("post", posts.id)],
      indexes: ["CREATE UNIQUE INDEX idx_profiles_post ON profiles (post)"],
    });
    const notes = await setup(t, "POST", c, {
      name: "notes",
      ...open,
      fields: [{ name: "text", type: "text" }],
    });
    const expandOnly = "@request.context = 'expand' && text = 'h1'";
    const hints = await setup(t, "POST", c, {
      name: "hints",
      listRule: expandOnly,
      viewRule: expandOnly,
      fields: [{ name: "text", type: "text" }],
    });
    const staff = await setup(t, "POST", c, {
      name: "staff",
      type: "auth",
      ...open,
      manageRule: "boss = @request.auth.id",
      fields: [rel("boss", members.id)],
    });
    // the rule needs a join through the owner relation
    const docs = await setup(t, "POST", c, {
      name: "docs",
      listRule: "",
      viewRule:
        "owner.name = 'm2' || (@request.auth.id != '' && owner = @request.auth.id)",
      fields: [
        { name: "title", type: "text" },
        rel("owner", members.id),
        rel("note", notes.id),
      ],
    });
    await setup(t, "POST", c, {
      name: "boards",
      ...open,
      fields: [
        rel("docs", docs.id, 5),
        rel("hints", hints.id, 5),
        rel("crew", staff.id, 5),
      ],
    });
  }
}, 60_000);

afterAll(async () => {
  await targets.stop();
});

// Records are created through `same` so the harness sees every id before it shows up as a relation value.
async function create(
  key: string,
  collection: string,
  body: (t: Target) => Json,
): Promise<void> {
  await same(async (t) => {
    const res = await api(t, "POST", records(collection), body(t));
    ids[t.name][key] = ((await res.clone().json()) as Json).id;
    return res;
  });
}

describe("setup", () => {
  test("records", async () => {
    await create("a1", "authors", () => ({ name: "Ann" }));
    await create("a2", "authors", () => ({ name: "Bob" }));
    await create("s1", "secrets", () => ({ name: "top" }));
    for (const [key, visible, author] of [
      ["m1", false, "a1"],
      ["m2", true, "a2"],
    ] as const) {
      await create(key, "members", (t) => ({
        email: `${key}@x.com`,
        emailVisibility: visible,
        password: "12345678",
        passwordConfirm: "12345678",
        name: key,
        note: "private",
        favorite: id(t, author),
      }));
    }
    await create("p1", "posts", (t) => ({
      title: "first",
      author: id(t, "a1"),
      tags: [id(t, "a1"), id(t, "a2")],
      secret: id(t, "s1"),
      editor: id(t, "a2"),
    }));
    await create("p2", "posts", (t) => ({
      title: "second",
      author: id(t, "a2"),
    }));
    for (const [key, message, post, user] of [
      ["c1", "x marks", "p1", "m1"],
      ["c2", "hello", "p1", "m2"],
      ["c3", "other", "p2", "m1"],
    ]) {
      await create(key!, "comments", (t) => ({
        message,
        post: id(t, post!),
        user: id(t, user!),
      }));
    }
    await create("l1", "likes", (t) => ({ posts: [id(t, "p1"), id(t, "p2")] }));
    await create("l2", "likes", (t) => ({ posts: [id(t, "p1")] }));
    await create("pr1", "profiles", (t) => ({ bio: "b", post: id(t, "p1") }));
    for (let i = 0; i <= 8; i++) {
      await create(`ch${i}`, "posts", (t) => ({
        title: `ch${i}`,
        parent: i === 0 ? "" : id(t, `ch${i - 1}`),
      }));
    }
    await create("n1", "notes", () => ({ text: "n1" }));
    await create("n2", "notes", () => ({ text: "n2" }));
    await create("d1", "docs", (t) => ({
      title: "d1",
      owner: id(t, "m2"),
      note: id(t, "n1"),
    }));
    await create("d2", "docs", (t) => ({
      title: "d2",
      owner: id(t, "m1"),
      note: id(t, "n2"),
    }));
    await create("d3", "docs", () => ({ title: "d3" }));
    await create("h1", "hints", () => ({ text: "h1" }));
    await create("h2", "hints", () => ({ text: "h2" }));
    for (const [key, boss] of [
      ["st1", "m1"],
      ["st2", "m2"],
    ]) {
      await create(key!, "staff", (t) => ({
        email: `${key}@x.com`,
        emailVisibility: false,
        password: "12345678",
        passwordConfirm: "12345678",
        boss: id(t, boss!),
      }));
    }
    await create("b1", "boards", (t) => ({
      docs: [id(t, "d1"), id(t, "d2"), id(t, "d3")],
      hints: [id(t, "h1"), id(t, "h2")],
      crew: [id(t, "st1"), id(t, "st2")],
    }));
    await same(async (t) => {
      const res = await api(
        t,
        "POST",
        "/api/collections/members/auth-with-password",
        { identity: "m1@x.com", password: "12345678" },
        null,
      );
      ids[t.name].m1Token = ((await res.clone().json()) as Json).token;
      return res;
    });
  });
});

const p1 = (query: string) => (t: Target) =>
  records("posts", `/${id(t, "p1")}?${query}`);

describe("expand", () => {
  test("single relation", async () => {
    await same(guestGet(p1("expand=author")));
  });

  test("multi relation", async () => {
    await same(guestGet(p1("expand=tags")));
  });

  test("nested relations on a list", async () => {
    await same(
      guestGet(() =>
        records("comments", "?sort=message&expand=post.author,user"),
      ),
    );
  });

  test("back-relation via a single relation field", async () => {
    await same(guestGet(p1("expand=comments_via_post")));
  });

  test("back-relation via a multi relation field", async () => {
    await same(guestGet(p1("expand=likes_via_posts")));
  });

  test("back-relation with a unique index expands one record", async () => {
    const pb = await same(guestGet(p1("expand=profiles_via_post")));
    expect(Array.isArray((pb.body as Json).expand.profiles_via_post)).toBe(
      false,
    );
  });

  test("nested back-relation hides emails unless visible", async () => {
    await same(guestGet(p1("expand=comments_via_post.user")));
  });

  test("paths sharing a prefix are merged", async () => {
    await same(
      guestGet(
        p1("expand=author,comments_via_post.user,comments_via_post.post.tags"),
      ),
    );
  });

  test("superuser sees hidden fields of expanded records", async () => {
    await same((t) => api(t, "GET", p1("expand=comments_via_post.user")(t)));
  });

  test("unknown paths are ignored", async () => {
    await same(guestGet(p1("expand=nope, author ,title,.")));
  });

  test("hidden relation field", async () => {
    await same(guestGet(p1("expand=editor")));
  });

  test("empty relation still returns an empty expand", async () => {
    await same(
      guestGet((t) => records("posts", `/${id(t, "p2")}?expand=tags`)),
    );
  });

  test("list with filter and expand", async () => {
    await same(
      guestGet(() =>
        records("posts", "?filter=(title~'s')&sort=title&expand=author,tags"),
      ),
    );
  });

  test("fields picker into expand", async () => {
    await same(guestGet(p1("expand=author,tags&fields=id,expand.author.name")));
  });

  test("create response", async () => {
    await same((t) =>
      api(
        t,
        "POST",
        records("posts", "?expand=author"),
        { title: "new", author: id(t, "a1") },
        null,
      ),
    );
  });

  test("update response", async () => {
    await same((t) =>
      api(
        t,
        "PATCH",
        records("posts", `/${id(t, "p2")}?expand=author,tags`),
        { tags: [id(t, "a1")] },
        null,
      ),
    );
  });

  test("auth response", async () => {
    await same((t) =>
      api(
        t,
        "POST",
        "/api/collections/members/auth-with-password?expand=favorite",
        { identity: "m1@x.com", password: "12345678" },
        null,
      ),
    );
  });
});

describe("expand authorization (Review Focus 4)", () => {
  test("a guest gets no expand key for a collection it cannot view", async () => {
    const pb = await same(guestGet(p1("expand=secret")));
    expect((pb.body as Json).expand).toBeUndefined();
  });

  test("a failed path leaves the other paths", async () => {
    const pb = await same(guestGet(p1("expand=secret,author")));
    expect(Object.keys((pb.body as Json).expand)).toEqual(["author"]);
  });

  test("a nested unviewable collection drops the whole path", async () => {
    const pb = await same(guestGet(p1("expand=comments_via_post.post.secret")));
    expect((pb.body as Json).expand).toBeUndefined();
  });

  test("a superuser expands it", async () => {
    await same((t) => api(t, "GET", p1("expand=secret")(t)));
  });

  test("a self-relation chain 8 levels deep stops at 6", async () => {
    const path = Array(8).fill("parent").join(".");
    const pb = await same(
      guestGet((t) => records("posts", `/${id(t, "ch8")}?expand=${path}`)),
    );
    let depth = 0;
    let node = pb.body as Json;
    while (node.expand?.parent) {
      node = node.expand.parent;
      depth++;
    }
    expect(depth).toBe(6);
    expect(node.title).toBe("ch2");
  });
});

describe("expand view rules (Review Focus 4)", () => {
  const b1 = (query: string) => (t: Target) =>
    records("boards", `/${id(t, "b1")}?${query}`);
  const asM1 = (path: (t: Target) => string) => (t: Target) =>
    api(t, "GET", path(t), undefined, id(t, "m1Token"));

  test("a guest gets only the records the rule allows, and nothing under the others", async () => {
    const pb = await same(guestGet(b1("expand=docs.note")));
    const docs = (pb.body as Json).expand.docs as Json[];
    expect(docs.map((d) => d.title)).toEqual(["d1"]);
    expect(docs[0]!.expand.note.text).toBe("n1");
    const text = JSON.stringify(pb.body);
    expect(text).not.toContain('"d2"');
    expect(text).not.toContain('"d3"');
    expect(text).not.toContain('"n2"');
  });

  test("an authenticated user also gets its own records, not the others", async () => {
    const pb = await same(asM1(b1("expand=docs.note")));
    const docs = (pb.body as Json).expand.docs as Json[];
    expect(docs.map((d) => d.title)).toEqual(["d1", "d2"]);
    expect(docs[1]!.expand.note.text).toBe("n2");
    expect(JSON.stringify(pb.body)).not.toContain('"d3"');
  });

  test("@request.context is expand inside the view rule", async () => {
    await same(
      guestGet((t) => records("hints", `/${id(t, "h1")}`)),
      404,
    );
    const pb = await same(guestGet(b1("expand=hints")));
    const hints = (pb.body as Json).expand.hints as Json[];
    expect(hints.map((h) => h.text)).toEqual(["h1"]);
  });

  test("the manage rule shows emails of managed expanded auth records", async () => {
    const pb = await same(asM1(b1("expand=crew")));
    const crew = (pb.body as Json).expand.crew as Json[];
    expect(crew.map((s) => s.email)).toEqual(["st1@x.com", undefined]);
    const guest = await same(guestGet(b1("expand=crew")));
    for (const s of (guest.body as Json).expand.crew)
      expect(s.email).toBeUndefined();
  });
});

describe("back-relations in filters and rules", () => {
  test("filter", async () => {
    await same(
      guestGet(() =>
        records(
          "posts",
          `?sort=title&filter=${encodeURIComponent('comments_via_post.message ?~ "x"')}`,
        ),
      ),
    );
  });

  test("totals with a partial and a full unique index", async () => {
    for (const t of [targets.pb, targets.hb]) {
      const posts = (await (
        await api(t, "GET", "/api/collections/posts")
      ).json()) as Json;
      await setup(t, "POST", "/api/collections", {
        name: "drafts",
        ...open,
        fields: [
          { name: "body", type: "text" },
          { name: "active", type: "bool" },
          rel("post", posts.id),
        ],
        indexes: [
          "CREATE UNIQUE INDEX idx_drafts_post ON drafts (post) WHERE active = TRUE",
        ],
      });
    }
    for (const key of ["d1", "d2", "d3"])
      await create(key, "drafts", (t) => ({ body: "x", post: id(t, "p1") }));
    for (const filter of [
      'drafts_via_post.body = "x"',
      'profiles_via_post.bio = "b"',
    ]) {
      const pb = await same(
        guestGet(() =>
          records("posts", `?filter=${encodeURIComponent(filter)}`),
        ),
      );
      expect((pb.body as Json).totalItems).toBe(1);
    }
  });

  test("list rule", async () => {
    const setRule = (rule: string) =>
      both((t) =>
        api(t, "PATCH", "/api/collections/posts", { listRule: rule }),
      );
    await setRule("comments_via_post.message ?~ 'hello'");
    try {
      await same(guestGet(() => records("posts", "?sort=title")));
    } finally {
      await setRule("");
    }
  });
});
