import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Target } from "../../core/contract/harness";
import type { HeybeClient } from "../src/client";
import { same, startPair, type Name, type Pair } from "./pair";

let pair: Pair;
const authors: Record<Name, string> = { pocketbase: "", heybe: "" };

const NAMES: Name[] = ["pocketbase", "heybe"];
const EMAIL = "a@example.com";
const PASSWORD = "1234567890";
const WAIT_MS = 2000;

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
          { name: "status", type: "select", values: ["a", "b"], maxSelect: 1 },
          {
            name: "author",
            type: "relation",
            collectionId: users.id,
            maxSelect: 1,
          },
        ],
      },
    });
    await admin.send("/api/collections", {
      method: "POST",
      body: {
        name: "secrets",
        type: "base",
        listRule: "@request.auth.id != ''",
        viewRule: "@request.auth.id != ''",
        fields: [{ name: "title", type: "text" }],
      },
    });
    authors[name] = (
      await admin.records("users").create({
        email: EMAIL,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      })
    ).id;
  }
}, 60_000);

afterAll(async () => {
  await pair?.stop();
});

function collector() {
  const lists: Record<string, unknown[]> = {};
  const waiters = new Set<() => void>();
  return {
    lists,
    on: (label: string) => (e: unknown) => {
      (lists[label] ??= []).push(e);
      for (const check of [...waiters]) check();
    },
    count: (label: string) => lists[label]?.length ?? 0,
    until(cond: () => boolean, what: string): Promise<void> {
      if (cond()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const check = () => {
          if (!cond()) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve();
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`timed out waiting for ${what}`));
        }, WAIT_MS);
        waiters.add(check);
      });
    },
  };
}

async function authed(t: Target): Promise<HeybeClient> {
  const c = pair.client(t.name);
  await c.auth("users").withPassword(EMAIL, PASSWORD);
  return c;
}

test("record events for guest and authed subscribers", async () => {
  await same(pair, async (guest, t) => {
    const admin = pair.admin[t.name].records("posts");
    const author = authors[t.name];
    const x = await admin.create({ title: "x", status: "a", author });
    const clients = [guest, await authed(t)];
    const seen = clients.map(() => collector());
    for (const [i, c] of clients.entries()) {
      await c.records("posts").subscribe("*", seen[i]!.on("all"), {
        where: { status: "a" },
        expand: { author: true },
      });
      await c.records("posts").subscribe(x.id, seen[i]!.on("one"));
    }
    await admin.create({ title: "y", status: "a", author });
    await admin.create({ title: "z", status: "b", author });
    await admin.update(x.id, { title: "x2" });
    await admin.delete(x.id);
    for (const s of seen)
      await s.until(
        () => s.count("all") >= 3 && s.count("one") >= 2,
        "post events",
      );
    for (const c of clients) await c.realtime.unsubscribe();
    expect(seen[0]!.lists.all![0]).not.toHaveProperty("record.expand.author");
    expect(seen[1]!.lists.all![0]).toHaveProperty("record.expand.author.id");
    return [{ id: author }, ...seen.map((s) => s.lists)];
  });
});

test("a rule that hides a record gives the same events", async () => {
  await same(pair, async (guest, t) => {
    const clients = [guest, await authed(t)];
    const seen = clients.map(() => collector());
    for (const [i, c] of clients.entries()) {
      await c.records("secrets").subscribe("*", seen[i]!.on("secrets"));
      await c.records("posts").subscribe("*", seen[i]!.on("posts"));
    }
    await pair.admin[t.name].records("secrets").create({ title: "s" });
    await pair.admin[t.name].records("posts").create({ title: "p" });
    for (const s of seen)
      await s.until(() => s.count("posts") >= 1, "the post event");
    await seen[1]!.until(() => seen[1]!.count("secrets") >= 1, "the secret");
    for (const c of clients) await c.realtime.unsubscribe();
    expect(seen[0]!.lists.secrets).toBeUndefined();
    return seen.map((s) => s.lists);
  });
});

test("authStore.clear() stops private events", async () => {
  await same(pair, async (_c, t) => {
    const admin = pair.admin[t.name];
    const c = await authed(t);
    const s = collector();
    await c.realtime.subscribe("HB_CONNECT", s.on("connect"));
    await c.records("secrets").subscribe("*", s.on("secrets"));
    await c.records("posts").subscribe("*", s.on("posts"));
    await s.until(() => s.count("connect") >= 1, "the first connect");
    await admin.records("secrets").create({ title: "before" });
    await s.until(() => s.count("secrets") >= 1, "the private event");

    c.authStore.clear();
    await s.until(() => s.count("connect") >= 2, "the reconnect");
    await admin.records("secrets").create({ title: "after" });
    await admin.records("posts").create({ title: "sentinel" });
    await s.until(() => s.count("posts") >= 1, "the sentinel");
    await c.realtime.unsubscribe();
    expect(s.lists.secrets).toHaveLength(1);
    return { secrets: s.lists.secrets, posts: s.lists.posts };
  });
});
