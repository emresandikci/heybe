import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Target, both, expectSame, startTargets } from "./harness";

let targets: Awaited<ReturnType<typeof startTargets>>;

const api = (
  t: Target,
  method: string,
  path: string,
  body?: unknown,
  token = t.superToken,
) =>
  fetch(`${t.url}${path}`, {
    method,
    headers: {
      authorization: token,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function same(
  method: string,
  path: string,
  status: number,
  body?: unknown,
  token?: (t: Target) => string,
) {
  const [pb, hb] = await both((t) =>
    api(t, method, path, body, token?.(t) ?? t.superToken),
  );
  expect(pb.status).toBe(status);
  expectSame(pb, hb);
  return pb.body as any;
}

async function eachOk(fn: (t: Target) => Promise<Response>) {
  for (const t of [targets.pb, targets.hb]) {
    const res = await fn(t);
    expect(res.status).toBe(200);
  }
}

const items = "/api/collections/req_items/records";
const USER = "requser00000001";
const fileNames: Record<string, string> = {};
const userTokens: Record<string, string> = {};

beforeAll(async () => {
  targets = await startTargets({
    heybeEntry: resolve(import.meta.dir, "extend/heybe.ts"),
    pbHooksDir: resolve(import.meta.dir, "extend/pb_hooks"),
  });
  await eachOk((t) =>
    api(t, "PATCH", "/api/settings", {
      batch: { enabled: true, maxRequests: 10 },
    }),
  );
  for (const t of [targets.pb, targets.hb]) {
    const res = await api(t, "POST", "/api/collections", {
      name: "req_tags",
      fields: [
        { name: "name", type: "text" },
        { name: "secret", type: "text" },
      ],
    });
    const tagsId = ((await res.json()) as { id: string }).id;
    await api(t, "POST", "/api/collections", {
      name: "req_items",
      fields: [
        { name: "title", type: "text" },
        { name: "secret", type: "text" },
        { name: "tag", type: "relation", collectionId: tagsId, maxSelect: 1 },
        { name: "doc", type: "file", maxSelect: 1 },
      ],
    });
  }
  await eachOk((t) =>
    api(t, "POST", "/api/collections/req_tags/records", {
      id: "tag000000000001",
      name: "tag",
      secret: "tag secret",
    }),
  );
  await eachOk((t) =>
    api(t, "POST", "/api/collections/users/records", {
      id: USER,
      email: "req@example.com",
      password: "12345678",
      passwordConfirm: "12345678",
    }),
  );
}, 60_000);

afterAll(async () => {
  await targets.stop();
});

test("onRecordCreateRequest changes a submitted field", async () => {
  const body = await same("POST", items, 200, {
    id: "item00000000001",
    title: "hello",
    secret: "s",
    tag: "tag000000000001",
  });
  expect(body.title).toBe("HELLO");
});

test("onRecordViewRequest answers without next()", async () => {
  await eachOk((t) =>
    api(t, "POST", items, { id: "item00000000002", title: "custom" }),
  );
  const body = await same("GET", `${items}/item00000000002`, 200);
  expect(body).toEqual({ custom: true, title: "CUSTOM" });
});

test("onRecordsListRequest drops items from the result", async () => {
  await eachOk((t) =>
    api(t, "POST", items, { id: "item00000000003", title: "drop" }),
  );
  const body = await same("GET", `${items}?sort=id`, 200);
  expect(body.items.map((i: { title: string }) => i.title)).not.toContain(
    "DROP",
  );
});

test("onRecordDeleteRequest blocks with a forbidden error", async () => {
  await eachOk((t) =>
    api(t, "POST", items, { id: "item00000000004", title: "protected" }),
  );
  const body = await same("DELETE", `${items}/item00000000004`, 403);
  expect(body.message).toBe("Protected.");
  await same("GET", `${items}/item00000000004`, 200);
});

test("onRecordEnrich hides a field and adds custom data, expanded records too", async () => {
  const view = await same("GET", `${items}/item00000000001?expand=tag`, 200);
  expect(view).not.toHaveProperty("secret");
  expect(view.label).toBe("enriched req_items");
  expect(view.expand.tag).not.toHaveProperty("secret");
  expect(view.expand.tag.label).toBe("enriched req_tags");
  const list = await same("GET", `${items}?sort=id&expand=tag`, 200);
  expect(list.items[0]).toEqual(view);
});

test("onCollectionCreateRequest rejects blocked names", async () => {
  const body = await same("POST", "/api/collections", 400, {
    name: "blocked_things",
    type: "base",
  });
  expect(body.message).toBe("Blocked name.");
});

test("onBatchRequest rejects big batches and sub-requests run their hooks", async () => {
  const create = (id: string) => ({
    method: "POST",
    url: "/api/collections/req_items/records?expand=tag",
    body: { id, title: "batch", tag: "tag000000000001" },
  });
  const big = await same("POST", "/api/batch", 400, {
    requests: [
      create("item00000000005"),
      create("item00000000006"),
      create("item00000000007"),
    ],
  });
  expect(big.message).toBe("Too many requests.");
  const ok = await same("POST", "/api/batch", 200, {
    requests: [create("item00000000005")],
  });
  expect(ok[0].body.title).toBe("BATCH");
  expect(ok[0].body.expand.tag.label).toBe("enriched req_tags");
});

test("onFileDownloadRequest changes the served name", async () => {
  for (const t of [targets.pb, targets.hb]) {
    const form = new FormData();
    form.append("id", "item00000000008");
    form.append("title", "file");
    form.append("doc", new File(["file text"], "doc.txt"));
    const res = await fetch(`${t.url}${items}`, {
      method: "POST",
      headers: { authorization: t.superToken },
      body: form,
    });
    expect(res.status).toBe(200);
    fileNames[t.name] = ((await res.json()) as { doc: string }).doc;
  }
  const [pb, hb] = await both(
    (t) =>
      fetch(
        `${t.url}/api/files/req_items/item00000000008/${fileNames[t.name]}`,
      ),
    { headers: ["content-disposition"] },
  );
  expect(pb.headers["content-disposition"]).toContain("renamed.txt");
  expectSame(pb, hb);
});

test("onFileTokenRequest rejects the records of one collection", async () => {
  for (const t of [targets.pb, targets.hb]) {
    const res = await api(
      t,
      "POST",
      "/api/collections/users/auth-with-password",
      { identity: "req@example.com", password: "12345678" },
    );
    expect(res.status).toBe(200);
    userTokens[t.name] = ((await res.json()) as { token: string }).token;
  }
  const body = await same(
    "POST",
    "/api/files/token",
    403,
    undefined,
    (t) => userTokens[t.name]!,
  );
  expect(body.message).toBe("No file tokens for users.");
  await same("POST", "/api/files/token", 200);
});

test("a superuser create answers with the saved record", async () => {
  await same("POST", "/api/collections/_otps/records", 200, {
    collectionRef: "_pb_users_auth_",
    recordRef: USER,
    password: "12345678",
  });
});

// stored files of a record, as "<recordId>/<name>" paths (without PB's .attrs sidecars)
function stored(t: Target, recordId: string): string[] {
  const root = join(t.dir, "storage");
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((p) => p.split("/"))
    .filter(
      (parts) =>
        parts.length === 3 &&
        parts[1] === recordId &&
        !parts[2]!.endsWith(".attrs"),
    )
    .map((parts) => parts.slice(1).join("/"));
}

function upload(
  t: Target,
  method: string,
  path: string,
  fields: Record<string, string>,
) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append("doc", new File(["upload"], "doc.txt"));
  return fetch(`${t.url}${path}`, {
    method,
    headers: { authorization: t.superToken },
    body: form,
  });
}

test("a create request hook that skips next() or throws stores nothing", async () => {
  for (const [id, title, status] of [
    ["item00000000009", "fail", 400],
    ["item00000000010", "skip", 200],
  ] as const) {
    const [pb, hb] = await both((t) => upload(t, "POST", items, { id, title }));
    expect(pb.status).toBe(status);
    expectSame(pb, hb);
    await same("GET", `${items}/${id}`, 404);
    for (const t of [targets.pb, targets.hb]) expect(stored(t, id)).toEqual([]);
  }
});

test("an update request hook that skips next() or throws changes nothing", async () => {
  const id = "item00000000011";
  const docs: Record<string, string> = {};
  for (const t of [targets.pb, targets.hb]) {
    const res = await upload(t, "POST", items, { id, title: "kept" });
    docs[t.name] = ((await res.json()) as { doc: string }).doc;
  }
  for (const [title, status] of [
    ["fail", 400],
    ["skip", 200],
  ] as const) {
    const [pb, hb] = await both((t) =>
      upload(t, "PATCH", `${items}/${id}`, { title }),
    );
    expect(pb.status).toBe(status);
    expectSame(pb, hb);
    for (const t of [targets.pb, targets.hb]) {
      const record = (await (await api(t, "GET", `${items}/${id}`)).json()) as {
        title: string;
        doc: string;
      };
      expect(record.title).toBe("KEPT");
      expect(record.doc).toBe(docs[t.name]!);
      expect(stored(t, id)).toEqual([`${id}/${docs[t.name]}`]);
    }
  }
});

test("uploads follow an id changed by the create request hook", async () => {
  const names: Record<string, string> = {};
  for (const t of [targets.pb, targets.hb]) {
    const res = await upload(t, "POST", items, {
      id: "item00000000012",
      title: "moved",
    });
    expect(res.status).toBe(200);
    names[t.name] = ((await res.json()) as { doc: string }).doc;
    expect(stored(t, "item00000000012")).toEqual([]);
    expect(stored(t, "itemmoved000001")).toEqual([
      `itemmoved000001/${names[t.name]}`,
    ]);
  }
  const [pb, hb] = await both((t) =>
    fetch(`${t.url}/api/files/req_items/itemmoved000001/${names[t.name]}`),
  );
  expect(pb.status).toBe(200);
  expectSame(pb, hb);
});

test("onRecordUpdateRequest changes reach the auth form checks", async () => {
  const token = (t: Target) => userTokens[t.name]!;
  const body = await same(
    "PATCH",
    `/api/collections/users/records/${USER}`,
    400,
    { name: "verify" },
    token,
  );
  expect(body.data).toHaveProperty("verified");
  await same(
    "PATCH",
    `/api/collections/users/records/${USER}`,
    200,
    { name: "plain" },
    token,
  );
});

test("collection request hooks", async () => {
  await eachOk((t) =>
    api(t, "POST", "/api/collections", { name: "req_members", type: "auth" }),
  );
  await eachOk((t) =>
    api(t, "POST", "/api/collections", { name: "req_locked", type: "base" }),
  );
  const view = await same("GET", "/api/collections/req_members", 200);
  expect(view.wrapped.name).toBe("req_members");
  expect(view.wrapped.authToken).toEqual({ duration: expect.any(Number) });
  const list = await same(
    "GET",
    "/api/collections?nosystem=1&sort=name&perPage=100",
    200,
  );
  expect(list.items.some((c: { system: boolean }) => c.system)).toBe(false);
  expect(
    (await same("PATCH", "/api/collections/req_locked", 400, {})).message,
  ).toBe("Locked.");
  expect(
    (await same("DELETE", "/api/collections/req_locked", 403)).message,
  ).toBe("Locked.");
  const imported = await same("PUT", "/api/collections/import", 400, {
    collections: [{ name: "req_imported", type: "base" }],
    deleteMissing: true,
  });
  expect(imported.message).toBe("No deleteMissing imports.");
});
