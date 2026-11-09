import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZipWriter } from "../src/backups/zip";
import { type FakeS3, startFakeS3 } from "../src/files/test-s3";
import {
  type Target,
  both,
  expectSame,
  startTargets,
  waitUntil,
} from "./harness";

type Json = Record<string, any>;

let targets: Awaited<ReturnType<typeof startTargets>>;
let s3: FakeS3;
let zip: Uint8Array<ArrayBuffer>;
// users' auth and file tokens
const users: Record<Target["name"], { auth: string; file: string }> = {
  pocketbase: { auth: "", file: "" },
  heybe: { auth: "", file: "" },
};
const DATE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DEFAULT_NAME = /pb_backup_acme_\d{14}\.zip/g;
const RANDOM_PART = /_[a-z0-9]{10}(?=\.)/g;
const SERVED_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "content-disposition",
  "content-security-policy",
  "cache-control",
];

const api = (
  t: Target,
  method: string,
  path: string,
  body?: FormData | Json,
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
        ? body
        : JSON.stringify(body),
  });

// default names and random name parts masked, list sizes and dates checked and replaced
async function masked(res: Response): Promise<Response> {
  const text = (await res.text())
    .replace(DEFAULT_NAME, "<default>")
    .replace(RANDOM_PART, "_<rand>");
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  if (Array.isArray(body))
    body = body.map((i: Json) => ({
      key: i.key,
      size: typeof i.size === "number" && i.size > 0,
      modified: DATE.test(i.modified),
    }));
  return Response.json(body, { status: res.status });
}

async function same(
  fn: (t: Target) => Promise<Response>,
  status: number,
): Promise<unknown> {
  const [pb, hb] = await both(async (t) => masked(await fn(t)));
  expect(pb.status).toBe(status);
  expectSame(pb, hb);
  return pb.body;
}

const list = (t: Target) => api(t, "GET", "/api/backups");
const create = (body?: Json) => (t: Target) =>
  api(t, "POST", "/api/backups", body);
const upload =
  (data: Uint8Array<ArrayBuffer> | string, name: string) => (t: Target) => {
    const form = new FormData();
    form.append("file", new File([data], name));
    return api(t, "POST", "/api/backups/upload", form);
  };

const superFileToken = async (t: Target) =>
  ((await (await api(t, "POST", "/api/files/token")).json()) as Json)
    .token as string;

// status and served headers; the body only when both servers hold the same bytes
async function served(t: Target, key: string, token: string | null) {
  const query = token === null ? "" : `?token=${token}`;
  const res = await fetch(`${t.url}/api/backups/${key}${query}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    status: res.status,
    lastModified: /GMT$/.test(res.headers.get("last-modified") ?? ""),
    headers: Object.fromEntries(
      [...res.headers].filter(([k]) => SERVED_HEADERS.includes(k)),
    ),
    body:
      res.status === 200
        ? new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
        : JSON.parse(new TextDecoder().decode(bytes)),
  };
}

const sameServed = async (key: string, token: "super" | "user" | null) => {
  const run = async (t: Target) =>
    served(
      t,
      key,
      token === "super"
        ? await superFileToken(t)
        : token === "user"
          ? users[t.name].file
          : null,
    );
  const [pb, hb] = await Promise.all([run(targets.pb), run(targets.hb)]);
  return { pb, hb };
};

const settings = async (patch: (t: Target) => Json) => {
  for (const t of [targets.pb, targets.hb]) {
    const res = await api(t, "PATCH", "/api/settings", patch(t));
    if (!res.ok) throw new Error(`${t.name}: ${await res.text()}`);
  }
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "heybe-backups-contract-"));
  try {
    await writeFile(join(dir, "entry.txt"), "hello");
    const writer = await createZipWriter(join(dir, "up.zip"));
    await writer.addFile(join(dir, "entry.txt"), "entry.txt");
    await writer.close();
    zip = new Uint8Array(await Bun.file(join(dir, "up.zip")).arrayBuffer());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  s3 = await startFakeS3();
  targets = await startTargets();
  for (const t of [targets.pb, targets.hb]) {
    const created = await api(t, "POST", "/api/collections/users/records", {
      email: "bk@example.com",
      password: "1234567890",
      passwordConfirm: "1234567890",
    });
    if (!created.ok) throw new Error(`${t.name}: ${await created.text()}`);
    const auth = await api(
      t,
      "POST",
      "/api/collections/users/auth-with-password",
      { identity: "bk@example.com", password: "1234567890" },
    );
    users[t.name].auth = ((await auth.json()) as Json).token;
    const file = await api(
      t,
      "POST",
      "/api/files/token",
      undefined,
      users[t.name].auth,
    );
    users[t.name].file = ((await file.json()) as Json).token;
  }
}, 60_000);

afterAll(async () => {
  await targets.stop();
  await s3.stop();
});

describe("local backups", () => {
  test("create and list", async () => {
    await same(create({ name: "bk1.zip" }), 204);
    expect(await same(list, 200)).toEqual([
      { key: "bk1.zip", size: true, modified: true },
    ]);
  });

  test("name validation", async () => {
    for (const name of ["bk1.zip", "Bad.zip", `${"a".repeat(147)}.zip`, 1])
      await same(create({ name }), 400);
  });

  test("create without a body generates the name", async () => {
    await same(create(), 204);
    expect(await same(list, 200)).toEqual([
      { key: "bk1.zip", size: true, modified: true },
      { key: "<default>", size: true, modified: true },
    ]);
  });

  test("download with and without tokens", async () => {
    const ok = await sameServed("bk1.zip", "super");
    expect(ok.pb.status).toBe(200);
    expect(ok.pb.lastModified).toBe(true);
    // the zips differ, so only the headers that do not depend on the bytes are compared
    const headers = (h: Record<string, string>) => {
      const { "content-length": _, ...rest } = h;
      return rest;
    };
    expect(headers(ok.hb.headers)).toEqual(headers(ok.pb.headers));
    for (const token of ["user", null] as const) {
      const denied = await sameServed("bk1.zip", token);
      expect(denied.pb.status).toBe(403);
      expect(denied.hb).toEqual(denied.pb);
    }
    const missing = await sameServed("missing.zip", "super");
    expect(missing.hb).toEqual(missing.pb);
  });

  test("upload", async () => {
    await same(upload(zip, "up.zip"), 204);
    await same(upload("hello", "text.zip"), 400);
    await same(upload(zip, "up.zip"), 400);
    await same(
      (t) => api(t, "POST", "/api/backups/upload", new FormData()),
      400,
    );
    const ok = await sameServed("up.zip", "super");
    expect(ok.pb.status).toBe(200);
    expect(ok.hb).toEqual(ok.pb);
  });

  test("delete", async () => {
    await same((t) => api(t, "DELETE", "/api/backups/up.zip"), 204);
    const out: unknown[] = [];
    for (const t of [targets.pb, targets.hb]) {
      const res = await api(t, "DELETE", "/api/backups/up.zip");
      const body = (await res.json()) as Json;
      out.push([res.status, body.message.split("Raw error:")[0]]);
    }
    expect(out[0]).toEqual([400, "Invalid or already deleted backup file. "]);
    expect(out[1]).toEqual(out[0]);
  });

  test("restore a missing backup", async () => {
    await same((t) => api(t, "POST", "/api/backups/missing.zip/restore"), 400);
  });

  test("guests and users", async () => {
    const routes: [string, string][] = [
      ["GET", "/api/backups"],
      ["POST", "/api/backups"],
      ["POST", "/api/backups/upload"],
      ["DELETE", "/api/backups/bk1.zip"],
      ["POST", "/api/backups/bk1.zip/restore"],
    ];
    for (const [method, path] of routes) {
      await same((t) => api(t, method, path, undefined, null), 401);
      await same(
        (t) => api(t, method, path, undefined, users[t.name].auth),
        403,
      );
    }
    await same(
      (t) => api(t, "GET", "/api/backups/bk1.zip", undefined, null),
      403,
    );
  });
});

describe("backups on S3", () => {
  const bucket = (t: Target) => (t.name === "pocketbase" ? "pb" : "hb");

  beforeAll(() =>
    settings((t) => ({
      backups: {
        s3: {
          enabled: true,
          bucket: bucket(t),
          region: "us-east-1",
          endpoint: s3.endpoint,
          accessKey: "key",
          secret: "secret",
          forcePathStyle: true,
        },
      },
    })),
  );

  afterAll(() => settings(() => ({ backups: { s3: { enabled: false } } })));

  test("create, list, download and delete", async () => {
    await same(create({ name: "s3.zip" }), 204);
    for (const t of [targets.pb, targets.hb])
      expect([...s3.objects(bucket(t)).keys()]).toEqual(["s3.zip"]);
    expect(await same(list, 200)).toEqual([
      { key: "s3.zip", size: true, modified: true },
    ]);
    await same(upload(zip, "up.zip"), 204);
    const ok = await sameServed("up.zip", "super");
    expect(ok.pb.status).toBe(200);
    expect(ok.hb).toEqual(ok.pb);
    const missing = await sameServed("missing.zip", "super");
    expect(missing.hb).toEqual(missing.pb);
    await same((t) => api(t, "DELETE", "/api/backups/s3.zip"), 204);
    await same((t) => api(t, "DELETE", "/api/backups/up.zip"), 204);
    expect(await same(list, 200)).toEqual([]);
  });
});

describe("restore", () => {
  test("round trip", async () => {
    const records = async (t: Target) => {
      const res = await api(t, "GET", "/api/collections/users/records").catch(
        () => null,
      );
      return res?.ok ? ((await res.json()) as Json) : null;
    };
    await same(create({ name: "rt.zip" }), 204);
    const before = await Promise.all([
      records(targets.pb),
      records(targets.hb),
    ]);
    for (const t of [targets.pb, targets.hb]) {
      const res = await api(t, "POST", "/api/collections/users/records", {
        email: "after@example.com",
        password: "1234567890",
        passwordConfirm: "1234567890",
      });
      expect(res.status).toBe(200);
    }
    await same((t) => api(t, "POST", "/api/backups/rt.zip/restore"), 204);
    const after = await Promise.all(
      [targets.pb, targets.hb].map((t) =>
        waitUntil(
          () => records(t),
          (v) => v?.totalItems === 1,
          15_000,
        ),
      ),
    );
    expect(after).toEqual(before);
    await same((t) => api(t, "GET", "/api/collections/users/records"), 200);
  }, 20_000);
});
