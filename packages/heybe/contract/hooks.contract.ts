import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type Target, both, expectSame, startTargets } from "./harness";

let targets: Awaited<ReturnType<typeof startTargets>>;

const api = (t: Target, method: string, path: string, body?: unknown) =>
  fetch(`${t.url}${path}`, {
    method,
    headers: {
      authorization: t.superToken,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function same(
  method: string,
  path: (t: Target) => string,
  status: number,
  body?: (t: Target) => unknown,
) {
  const [pb, hb] = await both((t) => api(t, method, path(t), body?.(t)));
  expect(pb.status).toBe(status);
  expectSame(pb, hb);
  return pb;
}

const ids: Record<string, Record<Target["name"], string>> = {};

async function create(key: string, collection: string, data: unknown) {
  ids[key] = { pocketbase: "", heybe: "" };
  for (const t of [targets.pb, targets.hb]) {
    const res = await api(
      t,
      "POST",
      `/api/collections/${collection}/records`,
      data,
    );
    expect(res.status).toBe(200);
    ids[key]![t.name] = ((await res.json()) as { id: string }).id;
  }
}

const text = (name: string) => ({ name, type: "text" });

beforeAll(async () => {
  targets = await startTargets({
    heybeEntry: resolve(import.meta.dir, "extend/heybe.ts"),
    pbHooksDir: resolve(import.meta.dir, "extend/pb_hooks"),
  });
  for (const [name, fields] of [
    ["hooked", [text("title"), text("slug")]],
    ["audit", [text("note")]],
  ] as const)
    await both((t) =>
      api(t, "POST", "/api/collections", { name, type: "base", fields }),
    );
}, 60_000);

afterAll(async () => {
  await targets.stop();
});

const records = "/api/collections/hooked/records";

test("onRecordCreate sets slug from title", async () => {
  const pb = await same(
    "POST",
    () => records,
    200,
    () => ({
      title: "Hello World",
    }),
  );
  expect((pb.body as { slug: string }).slug).toBe("hello-world");
});

test("onRecordUpdate throws a bad request for a blocked title", async () => {
  await create("update", "hooked", { title: "first" });
  const path = (t: Target) => `${records}/${ids.update![t.name]}`;
  const pb = await same("PATCH", path, 400, () => ({ title: "block" }));
  expect((pb.body as { message: string }).message).toBe("Blocked.");
  await same("PATCH", path, 200, () => ({ title: "fine" }));
});

test("onRecordDelete without next() keeps the record and answers 204", async () => {
  await create("keep", "hooked", { title: "keep" });
  const path = (t: Target) => `${records}/${ids.keep![t.name]}`;
  await same("DELETE", path, 204);
  await same("GET", path, 200);
});

test("onRecordAfterCreateSuccess creates an audit record", async () => {
  await create("audited", "hooked", { title: "audited" });
  const pb = await same(
    "GET",
    () => "/api/collections/audit/records?sort=note&filter=note~'audited'",
    200,
  );
  expect((pb.body as { totalItems: number }).totalItems).toBe(1);
});

test("deleting a user deletes its OTPs and auth origins", async () => {
  await create("user", "users", {
    email: "hooks@example.com",
    password: "12345678",
    passwordConfirm: "12345678",
  });
  for (const t of [targets.pb, targets.hb]) {
    const usersId = (
      (await (await api(t, "GET", "/api/collections/users")).json()) as {
        id: string;
      }
    ).id;
    const ref = { collectionRef: usersId, recordRef: ids.user![t.name] };
    for (const [collection, data] of [
      ["_otps", { ...ref, password: "12345678" }],
      ["_authOrigins", { ...ref, fingerprint: "abc" }],
    ] as const) {
      const res = await api(
        t,
        "POST",
        `/api/collections/${collection}/records`,
        data,
      );
      expect(res.status).toBe(200);
    }
  }
  const user = (t: Target) =>
    `/api/collections/users/records/${ids.user![t.name]}`;
  await same("GET", user, 200);
  const list = (collection: string) => (t: Target) =>
    `/api/collections/${collection}/records?filter=recordRef='${ids.user![t.name]}'`;
  for (const collection of ["_otps", "_authOrigins"]) {
    const pb = await same("GET", list(collection), 200);
    expect((pb.body as { totalItems: number }).totalItems).toBe(1);
  }
  await same("DELETE", user, 204);
  for (const collection of ["_otps", "_authOrigins"]) {
    const pb = await same("GET", list(collection), 200);
    expect((pb.body as { totalItems: number }).totalItems).toBe(0);
  }
});
