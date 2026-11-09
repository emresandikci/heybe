import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import sharp from "sharp";
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
const state: Record<Target["name"], Json> = { pocketbase: {}, heybe: {} };
const bucket = (t: Target) => (t.name === "pocketbase" ? "pb" : "hb");
// names shorter than 3 characters get one more random part before the separator
const RANDOM_PART = /([a-z0-9]{10})?_[a-z0-9]{10}(?=[."]|$)/g;
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

const s3Config = (t: Target) => ({
  enabled: true,
  bucket: bucket(t),
  region: "us-east-1",
  endpoint: s3.endpoint,
  accessKey: "key",
  secret: "secret",
  forcePathStyle: true,
});

const testS3 = (body?: Json) => (t: Target) =>
  api(t, "POST", "/api/settings/test/s3", body);

const settings = async (patch: (t: Target) => Json) => {
  for (const t of [targets.pb, targets.hb]) {
    const res = await api(t, "PATCH", "/api/settings", patch(t));
    if (!res.ok) throw new Error(`${t.name}: ${await res.text()}`);
  }
};

const keys = (t: Target) => [...s3.objects(bucket(t)).keys()];

// status, headers and the image size or body length, with random name parts masked
async function served(url: string, request: Record<string, string> = {}) {
  const res = await fetch(url, { headers: request });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const headers = Object.fromEntries(
    [...res.headers]
      .filter(([k]) => SERVED_HEADERS.includes(k))
      .map(([k, v]) => [k, v.replace(RANDOM_PART, "<rand>")]),
  );
  // thumb bytes differ between sharp and Go imaging
  if (url.includes("thumb=") && headers["content-length"])
    headers["content-length"] = "<thumb>";
  const image =
    res.status === 200 && res.headers.get("content-type")?.startsWith("image/")
      ? await sharp(bytes).metadata()
      : null;
  return {
    status: res.status,
    lastModified: /GMT$/.test(res.headers.get("last-modified") ?? ""),
    headers,
    size: image ? [image.width, image.height, image.format] : bytes.length,
  };
}

async function sameServed(
  url: (t: Target) => Promise<string>,
  headers: Record<string, string> = {},
) {
  const [pb, hb] = await Promise.all([
    url(targets.pb).then((u) => served(u, headers)),
    url(targets.hb).then((u) => served(u, headers)),
  ]);
  expect(hb).toEqual(pb);
  return pb;
}

beforeAll(async () => {
  s3 = await startFakeS3();
  targets = await startTargets();
}, 60_000);

afterAll(async () => {
  await targets.stop();
  await s3.stop();
});

describe("POST /api/settings/test/s3", () => {
  test("without a body", async () => {
    const [pb, hb] = await both(testS3());
    expect(pb.status).toBe(400);
    expectSame(pb, hb);
  });

  test("an unknown filesystem", async () => {
    const [pb, hb] = await both(testS3({ filesystem: "nope" }));
    expect(pb.status).toBe(400);
    expectSame(pb, hb);
  });

  test("S3 disabled", async () => {
    for (const filesystem of ["storage", "backups"]) {
      const [pb, hb] = await both(testS3({ filesystem }));
      expect(pb.status).toBe(400);
      expectSame(pb, hb);
    }
  });

  test("S3 enabled on storage and backups", async () => {
    await settings((t) => ({ s3: s3Config(t), backups: { s3: s3Config(t) } }));
    for (const filesystem of ["storage", "backups"]) {
      const [pb, hb] = await both(testS3({ filesystem }));
      expect(pb.status).toBe(204);
      expectSame(pb, hb);
    }
    expect(s3.requests.some((r) => r.path.includes("pb_settings_test_"))).toBe(
      true,
    );
    for (const t of [targets.pb, targets.hb]) expect(keys(t)).toEqual([]);
    await settings(() => ({ s3: { enabled: false } }));
  });

  test("an S3 failure", async () => {
    await settings((t) => ({ s3: s3Config(t) }));
    const messages: string[] = [];
    for (const t of [targets.pb, targets.hb]) {
      s3.failNext(500, "InternalError");
      const res = await testS3({ filesystem: "storage" })(t);
      expect(res.status).toBe(400);
      const body = (await res.json()) as Json;
      messages.push(body.message.split("Raw error:")[0]);
    }
    expect(messages[1]).toBe(messages[0]!);
    expect(messages[0]).toBe("Failed to test the S3 filesystem. ");
    await settings(() => ({ s3: { enabled: false } }));
  });
});

describe("storage on S3", () => {
  const fileToken = async (t: Target) =>
    ((await (await api(t, "POST", "/api/files/token")).json()) as Json)
      .token as string;
  const url = (t: Target, field: "doc" | "secret", query = "") => {
    const r = state[t.name].record as Json;
    return `${t.url}/api/files/docs/${r.id}/${r[field]}${query}`;
  };

  beforeAll(async () => {
    await settings((t) => ({ s3: s3Config(t) }));
    const png = await sharp({
      create: { width: 200, height: 100, channels: 3, background: "#c81e1e" },
    })
      .png()
      .toBuffer();
    for (const t of [targets.pb, targets.hb]) {
      const col = await api(t, "POST", "/api/collections", {
        name: "docs",
        type: "base",
        viewRule: '@request.auth.id != ""',
        createRule: "",
        deleteRule: "",
        fields: [
          { name: "doc", type: "file", maxSelect: 1 },
          { name: "secret", type: "file", maxSelect: 1, protected: true },
        ],
      });
      if (!col.ok) throw new Error(`${t.name}: ${await col.text()}`);
      state[t.name].collection = ((await col.json()) as Json).id;
    }
    const form = () => {
      const data = new FormData();
      data.append("doc", new File([png], "a.png"));
      data.append("secret", new File(["secret"], "s.txt"));
      return data;
    };
    const [pb, hb] = await both(async (t) => {
      const res = await api(t, "POST", "/api/collections/docs/records", form());
      state[t.name].record = await res.clone().json();
      return res;
    });
    expect(pb.status).toBe(200);
    expect(hb.status).toBe(200);
  });

  afterAll(() => settings(() => ({ s3: { enabled: false } })));

  test("a record create while S3 answers 500", async () => {
    const out: unknown[] = [];
    for (const t of [targets.pb, targets.hb]) {
      s3.failNext(500, "InternalError");
      const data = new FormData();
      data.append("doc", new File(["x"], "x.txt"));
      const res = await api(t, "POST", "/api/collections/docs/records", data);
      out.push({ status: res.status, body: await res.json() });
    }
    expect(out[0]).toMatchObject({ status: 400 });
    expect(out[1]).toEqual(out[0]);
  });

  test("record files land in the bucket", () => {
    for (const t of [targets.pb, targets.hb]) {
      const r = state[t.name].record as Json;
      const prefix = `${state[t.name].collection}/${r.id}/`;
      expect(
        keys(t)
          .filter((k) => k.startsWith(prefix))
          .sort(),
      ).toEqual([`${prefix}${r.doc}`, `${prefix}${r.secret}`].sort());
    }
  });

  test("download", async () => {
    const pb = await sameServed(async (t) => url(t, "doc"));
    expect(pb.status).toBe(200);
    expect(pb.lastModified).toBe(true);
    expect(pb.headers["content-length"]).toMatch(/^\d+$/);
    const ranged = await sameServed(async (t) => url(t, "doc"), {
      range: "bytes=10-19",
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers["content-length"]).toBe("10");
  });

  test("thumb", async () => {
    const pb = await sameServed(async (t) => url(t, "doc", "?thumb=100x100"));
    expect(pb.size).toEqual([100, 100, "png"]);
    for (const t of [targets.pb, targets.hb])
      expect(keys(t).some((k) => k.includes("/thumbs_"))).toBe(true);
  });

  test("protected download with a file token", async () => {
    expect((await sameServed(async (t) => url(t, "secret"))).status).toBe(404);
    const pb = await sameServed(async (t) =>
      url(t, "secret", `?token=${await fileToken(t)}`),
    );
    expect(pb.status).toBe(200);
  });

  test("record delete empties the record prefix", async () => {
    const [pb, hb] = await both((t) =>
      api(
        t,
        "DELETE",
        `/api/collections/docs/records/${state[t.name].record.id}`,
      ),
    );
    expect(pb.status).toBe(204);
    expectSame(pb, hb);
    for (const t of [targets.pb, targets.hb]) {
      const prefix = `${state[t.name].collection}/${state[t.name].record.id}/`;
      await waitUntil(
        async () => keys(t).filter((k) => k.startsWith(prefix)),
        (left) => left.length === 0,
      );
    }
  });
});
