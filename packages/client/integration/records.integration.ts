import { afterAll, beforeAll, expect, test } from "bun:test";
import { same, startPair, type Name, type Pair } from "./pair";

let pair: Pair;
const ids: Record<Name, Record<string, string>> = { pocketbase: {}, heybe: {} };

const NAMES: Name[] = ["pocketbase", "heybe"];

beforeAll(async () => {
  pair = await startPair();
  for (const name of NAMES) {
    const admin = pair.admin[name];
    const users = await admin.send<{ id: string }>("/api/collections/users");
    await admin.send("/api/collections", {
      method: "POST",
      body: {
        name: "posts",
        type: "base",
        listRule: "",
        viewRule: "",
        fields: [
          { name: "title", type: "text" },
          { name: "views", type: "number" },
          { name: "status", type: "select", values: ["a", "b"], maxSelect: 1 },
          {
            name: "author",
            type: "relation",
            collectionId: users.id,
            maxSelect: 1,
          },
          { name: "cover", type: "file", maxSelect: 1, maxSize: 1000000 },
        ],
      },
    });
    await admin.send("/api/collections", {
      method: "POST",
      body: {
        name: "secrets",
        type: "base",
        viewRule: "@request.auth.id != ''",
        fields: [{ name: "title", type: "text" }],
      },
    });
    ids[name].author = (
      await admin.records("users").create({
        email: "a@example.com",
        password: "1234567890",
        passwordConfirm: "1234567890",
      })
    ).id;
    ids[name].secret = (
      await admin.records("secrets").create({ title: "s" })
    ).id;
  }
}, 60_000);

afterAll(async () => {
  await pair?.stop();
});

test("create, findOne with expand", async () => {
  await same(pair, async (_c, t) => {
    const admin = pair.admin[t.name];
    const author = await admin.records("users").findOne(ids[t.name].author!);
    const created = await admin.records("posts").create({
      title: "first",
      views: 1,
      status: "a",
      author: author.id,
    });
    ids[t.name].p1 = created.id;
    const found = await admin
      .records("posts")
      .findOne(created.id, { expand: { author: true } });
    return [author, found];
  });
});

test("create with a file", async () => {
  await same(pair, async (_c, t) => {
    const posts = pair.admin[t.name].records("posts");
    const created = await posts.create({
      title: "file",
      cover: new File(["hello"], "c.png"),
    });
    await posts.delete(created.id);
    return { ...created, cover: created.cover ? "<file>" : "" };
  });
});

test("findMany with where, orderBy, expand, page and perPage", async () => {
  await same(pair, async (_c, t) => {
    const admin = pair.admin[t.name];
    for (const [title, views] of [
      ["second", 5],
      ["third", 9],
    ] as const)
      await admin.records("posts").create({
        title,
        views,
        status: "b",
        author: ids[t.name].author,
      });
    return admin.records("posts").findMany({
      where: { views: { gte: 1 }, OR: [{ status: "a" }, { status: "b" }] },
      orderBy: { views: "desc" },
      expand: { author: true },
      page: 2,
      perPage: 2,
    });
  });
});

test("count false skips totals", async () => {
  await same(pair, async (c) => {
    const list = await c.records("posts").findMany({ count: false });
    expect(list.totalItems).toBe(-1);
    return list;
  });
});

test("findFirst hit and 404", async () => {
  await same(pair, (c) =>
    c.records("posts").findFirst({
      where: { title: "second" },
      expand: { author: true },
    }),
  );
  await same(pair, (c) =>
    c.records("posts").findFirst({ where: { title: "missing" } }),
  );
});

test("update and delete", async () => {
  await same(pair, async (_c, t) => {
    const posts = pair.admin[t.name].records("posts");
    const updated = await posts.update(ids[t.name].p1!, { title: "renamed" });
    await posts.delete(ids[t.name].p1!);
    return updated;
  });
  await same(pair, (_c, t) =>
    pair.admin[t.name].records("posts").findOne(ids[t.name].p1!),
  );
});

test("rule-denied requests", async () => {
  await same(pair, (c) => c.records("secrets").findMany());
  await same(pair, (c, t) => c.records("secrets").findOne(ids[t.name].secret!));
});

test("where with quoted, backslashed and newline values", async () => {
  await same(pair, async (_c, t) => {
    const admin = pair.admin[t.name];
    const titles = ['say "hi"', "it's", "back\\slash", "a\nb"];
    for (const title of titles) await admin.records("posts").create({ title });
    const out: unknown[] = [];
    for (const title of titles)
      out.push(
        (await admin.records("posts").findMany({ where: { title } })).items.map(
          (r) => r.title,
        ),
      );
    return out;
  });
});

test("updating and deleting the authenticated record syncs the auth store", async () => {
  await same(pair, async (c, t) => {
    const email = "self@example.com";
    const password = "1234567890";
    await pair.admin[t.name]
      .records("users")
      .create({ email, password, passwordConfirm: password, name: "old" });
    const auth = await c.send<{
      token: string;
      record: { id: string; collectionId: string; collectionName: string };
    }>("/api/collections/users/auth-with-password", {
      method: "POST",
      body: { identity: email, password },
    });
    c.authStore.save(auth.token, auth.record);

    const users = c.records("users");
    await users.update(auth.record.id, { name: "new" });
    const afterUpdate = {
      name: c.authStore.record?.name,
      tokenKept: c.authStore.token === auth.token,
    };
    await users.delete(auth.record.id);
    return {
      afterUpdate,
      afterDelete: { token: c.authStore.token, record: c.authStore.record },
    };
  });
});
