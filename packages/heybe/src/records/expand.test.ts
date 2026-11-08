import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type App, createApp } from "../app";
import { statementCacheSize } from "../db";
import type { RequestInfo } from "../filter/compile";
import { expandRecords } from "./expand";

const now = () => new Date("2026-01-01T00:00:00.000Z");

let app: App;
let posts: string;

const guest: RequestInfo = {
  auth: null,
  authCollection: null,
  body: {},
  query: {},
  headers: {},
  method: "GET",
  context: "default",
};

beforeEach(async () => {
  app = createApp({ dir: "", now });
  const authors = await app.collections.save({
    name: "authors",
    viewRule: "",
    fields: [{ name: "name", type: "text" }],
  } as any);
  await app.collections.save({
    name: "secrets",
    fields: [{ name: "name", type: "text" }],
  } as any);
  posts = (
    await app.collections.save({
      name: "posts",
      viewRule: "",
      fields: [
        { name: "title", type: "text" },
        {
          name: "author",
          type: "relation",
          collectionId: authors.id,
          maxSelect: 1,
        },
        {
          name: "secret",
          type: "relation",
          collectionId: app.collections.find("secrets")!.id,
          maxSelect: 1,
        },
      ],
    } as any)
  ).id;
  await app.collections.save({
    name: "comments",
    viewRule: "",
    fields: [
      { name: "post", type: "relation", collectionId: posts, maxSelect: 1 },
    ],
  } as any);
});

afterEach(() => app.close());

const expandOne = (
  record: Record<string, unknown>,
  paths: string[],
  request: RequestInfo | null = guest,
) =>
  expandRecords(
    app,
    app.collections.find("posts")!,
    [record],
    paths,
    request,
  )[0]!;

describe("expandRecords", () => {
  test("back-relations stop at 1000 records per parent", async () => {
    const post = await app.records("posts").create({ title: "p" });
    app.db.tx(() => {
      for (let i = 0; i < 1001; i++)
        app.db.run("INSERT INTO comments (id, post) VALUES (?, ?)", [
          `c${String(i).padStart(14, "0")}`,
          post.id,
        ]);
    });
    const out = expandOne(post, ["comments_via_post"]) as any;
    const list = out.expand.comments_via_post as { id: string }[];
    expect(list).toHaveLength(1000);
    expect(list[0]!.id).toBe("c00000000000000");
    expect(list[999]!.id).toBe("c00000000000999");
  });

  test("a guest gets no expand for a superuser-only collection", async () => {
    const secret = await app.records("secrets").create({ name: "s" });
    const post = await app.records("posts").create({ secret: secret.id });
    expect(expandOne(post, ["secret"])).not.toHaveProperty("expand");
    expect((expandOne(post, ["secret"], null) as any).expand.secret.id).toBe(
      secret.id,
    );
  });

  test("invalid paths are dropped without logging", async () => {
    const post = await app.records("posts").create({ title: "p" });
    const log = spyOn(console, "error");
    try {
      expect(expandOne(post, ["nope", "title", "secret"])).not.toHaveProperty(
        "expand",
      );
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  test("the statement cache does not grow with the number of ids", async () => {
    const author = await app.records("authors").create({ name: "a" });
    const many = [];
    for (let i = 0; i < 5; i++)
      many.push(await app.records("posts").create({ author: author.id }));
    expandRecords(
      app,
      app.collections.find("posts")!,
      many.slice(0, 1),
      ["author", "comments_via_post"],
      guest,
    );
    const size = statementCacheSize(app.db);
    expandRecords(
      app,
      app.collections.find("posts")!,
      many,
      ["author", "comments_via_post"],
      guest,
    );
    expect(statementCacheSize(app.db)).toBe(size);
  });
});

describe("programmatic API", () => {
  test("findOne and findMany expand without rules", async () => {
    const secret = await app.records("secrets").create({ name: "s" });
    const post = await app.records("posts").create({ secret: secret.id });
    const one = (await app
      .records("posts")
      .findOne(post.id as string, { expand: { secret: true } })) as any;
    expect(one.expand.secret.name).toBe("s");
    const many = (await app
      .records("posts")
      .findMany({ expand: { secret: true } })) as any;
    expect(many.items[0].expand.secret.name).toBe("s");
  });
});
