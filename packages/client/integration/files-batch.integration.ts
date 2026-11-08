import { afterAll, beforeAll, expect, test } from "bun:test";
import type { HeybeClient } from "../src/client";
import { same, startPair, type Name, type Pair } from "./pair";

let pair: Pair;
const NAMES: Name[] = ["pocketbase", "heybe"];
const ids: Record<Name, Record<string, string>> = { pocketbase: {}, heybe: {} };

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

const stable = (name: string) =>
  name.replace(/(_[a-z0-9]{10})+(\.\w+)?$/, "$2");

function stableFiles(
  record: Record<string, unknown>,
  rename: (name: string) => string = stable,
) {
  const out = { ...record };
  for (const key of ["docs", "secret"]) {
    const value = out[key];
    if (typeof value === "string") out[key] = rename(value);
    else if (Array.isArray(value)) out[key] = value.map(rename);
  }
  return out;
}

async function fetched(url: string, opts: { bytes?: boolean } = {}) {
  const res = await fetch(url);
  const type = res.headers.get("content-type");
  const bytes = new Uint8Array(await res.arrayBuffer());
  const body = type?.startsWith("application/json")
    ? JSON.parse(new TextDecoder().decode(bytes))
    : new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return {
    status: res.status,
    type,
    ...(opts.bytes === false ? {} : { body }),
  };
}

const ext = (name: string) => name.match(/\.\w+$/)?.[0] ?? "";

beforeAll(async () => {
  pair = await startPair();
  for (const name of NAMES) {
    const admin = pair.admin[name];
    await admin.send("/api/settings", {
      method: "PATCH",
      body: { batch: { enabled: true, maxRequests: 50 } },
    });
    await admin.send("/api/collections", {
      method: "POST",
      body: {
        name: "docs",
        type: "base",
        listRule: "",
        viewRule: "",
        fields: [
          { name: "title", type: "text" },
          {
            name: "docs",
            type: "file",
            maxSelect: 5,
            maxSize: 1000000,
            thumbs: ["100x100"],
          },
        ],
      },
    });
    await admin.send("/api/collections", {
      method: "POST",
      body: {
        name: "vault",
        type: "base",
        viewRule: "@request.auth.id != ''",
        fields: [
          {
            name: "secret",
            type: "file",
            maxSelect: 1,
            maxSize: 1000000,
            protected: true,
          },
        ],
      },
    });
  }
}, 60_000);

afterAll(async () => {
  await pair?.stop();
});

test("create with two files, update appending one, fetch urls", async () => {
  await same(pair, async (_c, t) => {
    const admin = pair.admin[t.name];
    const docs = admin.records("docs");
    const created = await docs.create({
      title: "d",
      docs: [
        new File(["one"], "one.txt", { type: "text/plain" }),
        new File([PNG], "pic.png", { type: "image/png" }),
      ],
    });
    const updated = await docs.update(created.id, {
      docs: [
        ...(created.docs as string[]),
        new File(["three"], "three.txt", { type: "text/plain" }),
      ],
    });
    const names = updated.docs as string[];
    const png = names.find((n) => n.startsWith("pic"))!;
    const txt = names.find((n) => n.startsWith("one"))!;
    return {
      created: stableFiles(created),
      updated: stableFiles(updated),
      text: await fetched(admin.files.url(updated, txt)),
      png: await fetched(admin.files.url(updated, png)),
      thumb: await fetched(
        admin.files.url(updated, png, { thumb: "100x100" }),
        {
          bytes: false,
        },
      ),
    };
  });
});

test("protected file with and without a token", async () => {
  await same(pair, async (_c, t) => {
    const admin = pair.admin[t.name];
    const record = await admin.records("vault").create({
      secret: new File(["hidden"], "s.txt", { type: "text/plain" }),
    });
    const url = admin.files.url(record, record.secret as string);
    const token = await admin.files.token();
    expect(token).not.toBe("");
    return {
      without: await fetched(url),
      withToken: await fetched(
        admin.files.url(record, record.secret as string, { token }),
      ),
    };
  });
});

test("batch mixing create, update, upsert and delete", async () => {
  await same(pair, async (_c, t) => {
    const admin = pair.admin[t.name];
    const docs = admin.records("docs");
    const keep = await docs.create({ title: "keep" });
    const drop = await docs.create({ title: "drop" });
    const batch = admin.batch();
    const records = batch.records("docs");
    records.create({
      title: "new",
      docs: [new File(["batched"], "b.txt", { type: "text/plain" })],
    });
    records.update(keep.id, { title: "kept" });
    records.upsert({ id: "upserted0000001", title: "up" });
    records.delete(drop.id);
    const results = await batch.send();
    return results.map((r) => ({
      status: r.status,
      body:
        r.body && typeof r.body === "object"
          ? stableFiles(r.body as Record<string, unknown>, ext)
          : r.body,
    }));
  });
});

test("a failing batch returns the rule error body", async () => {
  await same(pair, async (c) => {
    const batch = c.batch();
    batch.records("docs").create({ title: "denied" });
    return batch.send();
  });
});

test("batch update with a mixed array keeps names and appends the file", async () => {
  await same(pair, async (_c, t) => {
    const admin = pair.admin[t.name];
    const created = await admin.records("docs").create({
      title: "mixed",
      docs: [new File(["one"], "one.txt", { type: "text/plain" })],
    });
    const batch = admin.batch();
    batch.records("docs").update(created.id, {
      docs: [
        ...(created.docs as string[]),
        new File(["two"], "two.txt", { type: "text/plain" }),
      ],
    });
    const [result] = await batch.send();
    return {
      status: result!.status,
      body: stableFiles(result!.body as Record<string, unknown>),
    };
  });
});
