import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Snapshot,
  type Target,
  both,
  expectSame,
  startTargets,
} from "./harness";

let targets: Awaited<ReturnType<typeof startTargets>>;

type Json = Record<string, any>;

const FIXTURES = resolve(import.meta.dir, "../src/files/fixtures");
const fixture = (name: string, as = name) =>
  new File([Bun.file(join(FIXTURES, name))], as);
// names shorter than 3 characters get one more random part before the separator
const RANDOM_PART = /([a-z0-9]{10})?_[a-z0-9]{10}(?=[."]|$)/g;
const MAX_BODY = (32 << 20) + (5 << 20) + 3 * 1000;

const state: Record<Target["name"], Json> = { pocketbase: {}, heybe: {} };
const id = (t: Target, key: string) => state[t.name][key] as string;
const records = (query = "") => `/api/collections/docs/records${query}`;

const api = (
  t: Target,
  method: string,
  path: string,
  body?: FormData | Json | BodyInit,
  token: string | null = t.superToken,
) => {
  const json =
    body !== undefined &&
    !(body instanceof FormData) &&
    !(body instanceof ReadableStream) &&
    typeof body === "object" &&
    !(body instanceof Blob);
  return fetch(`${t.url}${path}`, {
    method,
    headers: {
      ...(json ? { "content-type": "application/json" } : {}),
      ...(token === null ? {} : { authorization: token }),
    },
    body: json ? JSON.stringify(body) : (body as BodyInit | undefined),
  });
};

const form = (entries: [string, string | File][]) => {
  const data = new FormData();
  for (const [k, v] of entries) data.append(k, v);
  return data;
};

// PB's local blob driver keeps a `.attrs` file next to each file
const isAttrs = (name: string) => name.endsWith(".attrs");

// uploaded names end with a random part, so it is masked the same way on both targets
const maskNames = (value: unknown): unknown => {
  if (typeof value === "string")
    return value.replace(RANDOM_PART, (_, short) =>
      short ? "<rand>_<rand>" : "_<rand>",
    );
  if (Array.isArray(value)) return value.map(maskNames);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, maskNames(v)]),
    );
  return value;
};

async function same(
  fn: (t: Target) => Promise<Response>,
  status?: number,
): Promise<[Snapshot, Snapshot]> {
  const [pb, hb] = await both(fn);
  if (status !== undefined) expect(pb.status).toBe(status);
  expectSame(
    { ...pb, body: maskNames(pb.body) },
    { ...hb, body: maskNames(hb.body) },
  );
  return [pb, hb];
}

async function remember(t: Target, key: string, res: Response) {
  state[t.name][key] = await res.clone().json();
  return res;
}

const record = (t: Target, key: string) => state[t.name][key] as Json;

function storedFiles(t: Target, key: string): string[] {
  const dir = join(t.dir, "storage", id(t, "collection"), record(t, key).id);
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => !isAttrs(n))
        .sort()
    : [];
}

function allStored(t: Target): string[] {
  const root = join(t.dir, "storage");
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && !isAttrs(d.name))
    .map((d) => join(d.parentPath, d.name));
}

const fileNames = (r: Json) =>
  [r.file, ...r.files].filter((n: string) => n !== "").sort();

beforeAll(async () => {
  targets = await startTargets();
  for (const t of [targets.pb, targets.hb]) {
    const res = await api(t, "POST", "/api/collections", {
      name: "docs",
      type: "base",
      listRule: "",
      viewRule: "",
      createRule: '@request.body.title != "deny"',
      fields: [
        { name: "title", type: "text" },
        { name: "file", type: "file", maxSelect: 1 },
        {
          name: "files",
          type: "file",
          maxSelect: 3,
          maxSize: 1000,
          mimeTypes: ["image/png", "text/plain"],
        },
      ],
    });
    if (!res.ok) throw new Error(`${t.name}: ${await res.text()}`);
    state[t.name].collection = ((await res.json()) as Json).id;
  }
}, 60_000);

afterAll(async () => {
  await targets.stop();
});

describe("multipart create", () => {
  test("one file", async () => {
    const [pb] = await same(
      (t) =>
        api(
          t,
          "POST",
          records(),
          form([
            ["title", "one"],
            ["file", fixture("a.txt", "Hello World.txt")],
          ]),
        ).then((r) => remember(t, "one", r)),
      200,
    );
    expect(pb.body as Json).toMatchObject({
      file: expect.stringMatching(/^hello_world_[a-z0-9]{10}\.txt$/),
    });
    for (const t of [targets.pb, targets.hb])
      expect(storedFiles(t, "one")).toEqual(fileNames(record(t, "one")));
  });

  test("three files", async () => {
    await same(
      (t) =>
        api(
          t,
          "POST",
          records(),
          form([
            ["files", fixture("a.png")],
            ["files", fixture("a.txt")],
            ["files", fixture("a.png", "second.png")],
          ]),
        ).then((r) => remember(t, "three", r)),
      200,
    );
    for (const t of [targets.pb, targets.hb])
      expect(storedFiles(t, "three")).toEqual(fileNames(record(t, "three")));
  });

  test("an extension-less name gets one from the content", async () => {
    await same(
      (t) =>
        api(t, "POST", records(), form([["file", fixture("a.png", "image")]])),
      200,
    );
  });

  test("too many files", async () => {
    await same(
      (t) =>
        api(
          t,
          "POST",
          records(),
          form([
            ["files", fixture("a.png")],
            ["files", fixture("a.png")],
            ["files", fixture("a.txt")],
            ["files", fixture("a.txt")],
          ]),
        ),
      400,
    );
  });

  test("file over maxSize", async () => {
    await same(
      (t) =>
        api(
          t,
          "POST",
          records(),
          form([["files", new File(["x".repeat(1001)], "big.txt")]]),
        ),
      400,
    );
  });

  test("wrong mime type (a pdf named .png)", async () => {
    await same(
      (t) =>
        api(
          t,
          "POST",
          records(),
          form([["files", fixture("a.pdf", "fake.png")]]),
        ),
      400,
    );
  });

  test("@jsonPayload mixed with files", async () => {
    await same(
      (t) =>
        api(
          t,
          "POST",
          records(),
          form([
            ["title", "plain"],
            ["@jsonPayload", JSON.stringify({ title: "from json" })],
            ["file", fixture("a.txt")],
          ]),
        ),
      200,
    );
  });

  test("a failed create (rule) leaves no files in storage", async () => {
    const before = {
      pocketbase: allStored(targets.pb),
      heybe: allStored(targets.hb),
    };
    await same(
      (t) =>
        api(
          t,
          "POST",
          records(),
          form([
            ["title", "deny"],
            ["file", fixture("a.txt")],
          ]),
          null,
        ),
      400,
    );
    expect(allStored(targets.pb)).toEqual(before.pocketbase);
    expect(allStored(targets.hb)).toEqual(before.heybe);
  });

  test("more than 1000 parts is rejected like PB", async () => {
    const parts = (n: number) =>
      Array.from({ length: n }, (): [string, string] => ["title", "x"]);
    await same(
      (t) =>
        api(t, "POST", records(), form([...parts(999), ["files", "nope"]])),
      400,
    );
    await same((t) => api(t, "POST", records(), form(parts(1001))), 400);
  });

  test("a body over the collection limit gets 413", async () => {
    const big = new File([new Uint8Array(MAX_BODY)], "big.bin");
    await same((t) => api(t, "POST", records(), form([["file", big]])), 413);
  });

  test("a streamed body over the collection limit gets 413 while reading", async () => {
    const boundary = "xBOUNDARYx";
    const head = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const chunk = new Uint8Array(1 << 20);
    const [pb, hb] = await both((t) => {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === 0) controller.enqueue(head);
          if (sent > MAX_BODY + (2 << 20)) return controller.close();
          controller.enqueue(chunk);
          sent += chunk.length;
        },
      });
      return fetch(`${t.url}${records()}`, {
        method: "POST",
        headers: {
          authorization: t.superToken,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
        duplex: "half",
      } as RequestInit);
    });
    expect(pb.status).toBe(413);
    expectSame(pb, hb);
  });
});

describe("multipart update", () => {
  test("replacing the single file removes the old one from storage", async () => {
    const old = {
      pocketbase: record(targets.pb, "one").file,
      heybe: record(targets.hb, "one").file,
    };
    await same(
      (t) =>
        api(
          t,
          "PATCH",
          records(`/${record(t, "one").id}`),
          form([["file", fixture("a.png", "replaced.png")]]),
        ).then((r) => remember(t, "one", r)),
      200,
    );
    for (const t of [targets.pb, targets.hb]) {
      expect(storedFiles(t, "one")).toEqual(fileNames(record(t, "one")));
      expect(storedFiles(t, "one")).not.toContain(old[t.name]);
    }
  });

  test("files+ appends", async () => {
    await same(
      (t) =>
        api(
          t,
          "PATCH",
          records(`/${record(t, "one").id}`),
          form([
            ["files+", fixture("a.png")],
            ["files+", fixture("a.txt")],
          ]),
        ).then((r) => remember(t, "one", r)),
      200,
    );
    for (const t of [targets.pb, targets.hb])
      expect(storedFiles(t, "one")).toEqual(fileNames(record(t, "one")));
  });

  test("files- removes by name", async () => {
    await same(
      (t) =>
        api(t, "PATCH", records(`/${record(t, "one").id}`), {
          "files-": [record(t, "one").files[0]],
        }).then((r) => remember(t, "one", r)),
      200,
    );
    for (const t of [targets.pb, targets.hb]) {
      expect(record(t, "one").files).toHaveLength(1);
      expect(storedFiles(t, "one")).toEqual(fileNames(record(t, "one")));
    }
  });

  test("existing names are kept next to new uploads", async () => {
    await same(
      (t) =>
        api(
          t,
          "PATCH",
          records(`/${record(t, "one").id}`),
          form([
            ["files", record(t, "one").files[0]],
            ["files", fixture("a.txt", "kept.txt")],
          ]),
        ).then((r) => remember(t, "one", r)),
      200,
    );
    for (const t of [targets.pb, targets.hb])
      expect(storedFiles(t, "one")).toEqual(fileNames(record(t, "one")));
  });

  test("an unknown existing name is rejected", async () => {
    await same(
      (t) =>
        api(t, "PATCH", records(`/${record(t, "one").id}`), {
          files: ["missing_abcdefghij.png"],
        }),
      400,
    );
  });

  test("clearing with an empty string removes the files", async () => {
    await same(
      (t) =>
        api(
          t,
          "PATCH",
          records(`/${record(t, "one").id}`),
          form([
            ["file", ""],
            ["files", ""],
          ]),
        ).then((r) => remember(t, "one", r)),
      200,
    );
    for (const t of [targets.pb, targets.hb])
      expect(storedFiles(t, "one")).toEqual([]);
  });

  test("a failed update keeps the old files and stores no new ones", async () => {
    const before = {
      pocketbase: storedFiles(targets.pb, "three"),
      heybe: storedFiles(targets.hb, "three"),
    };
    await same(
      (t) =>
        api(
          t,
          "PATCH",
          records(`/${record(t, "three").id}`),
          form([
            ["file", fixture("a.txt")],
            ["files+", fixture("a.png")],
          ]),
        ),
      400,
    );
    expect(storedFiles(targets.pb, "three")).toEqual(before.pocketbase);
    expect(storedFiles(targets.hb, "three")).toEqual(before.heybe);
  });
});

describe("record delete", () => {
  // PB deletes the dir in a background goroutine, so only Heybe is checked
  test("removes the record storage dir", async () => {
    await same(
      (t) => api(t, "DELETE", records(`/${record(t, "three").id}`)),
      204,
    );
    expect(storedFiles(targets.hb, "three")).toEqual([]);
  });
});
