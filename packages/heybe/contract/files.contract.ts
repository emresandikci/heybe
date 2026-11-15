import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
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

// file times differ between the targets, so only the format is compared
const maskLastModified = (headers: Snapshot["headers"]) =>
  "last-modified" in headers
    ? {
        ...headers,
        "last-modified":
          /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
            headers["last-modified"]!,
          )
            ? "<date>"
            : headers["last-modified"]!,
      }
    : headers;

async function same(
  fn: (t: Target) => Promise<Response>,
  status?: number,
  headers?: string[],
): Promise<[Snapshot, Snapshot]> {
  const [pb, hb] = await both(fn, { headers });
  if (status !== undefined) expect(pb.status).toBe(status);
  const masked = (s: Snapshot) => ({
    ...s,
    headers: maskLastModified(maskNames(s.headers) as Snapshot["headers"]),
    body: maskNames(s.body),
  });
  expectSame(masked(pb), masked(hb));
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
    // The head alone takes the body over the limit, so the unread rest stays under the 256 KB that
    // Go drains after a response. A larger rest makes PB close the connection mid-upload and the
    // client can retry the half-sent stream, which PB answered with a 400.
    const [pb, hb] = await both((t) => {
      let left = MAX_BODY;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(head);
        },
        pull(controller) {
          if (left === 0) return controller.close();
          const n = Math.min(left, chunk.length);
          controller.enqueue(chunk.subarray(0, n));
          left -= n;
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

const SERVED_HEADERS = [
  "accept-ranges",
  "content-range",
  "last-modified",
  "content-disposition",
  "content-security-policy",
  "cache-control",
  "x-frame-options",
  "x-content-type-options",
];

const fileUrl = (t: Target, key: string, query = "", name?: string) => {
  const r = record(t, key);
  return `${t.url}/api/files/${id(t, "collection")}/${r.id}/${name ?? fileNames(r)[0]}${query}`;
};

describe("download", () => {
  beforeAll(async () => {
    const uploads: [string, [string, string | File][]][] = [
      ["txt", [["file", fixture("a.txt")]]],
      ["png", [["file", fixture("a.png")]]],
      ["pdf", [["file", fixture("a.pdf")]]],
      ["svgExt", [["file", fixture("a.txt", "note.svg")]]],
      [
        "svg",
        [
          [
            "file",
            new File(
              [
                '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
              ],
              "pic.svg",
            ),
          ],
        ],
      ],
      [
        "html",
        [["file", new File(["<html><script>1</script></html>"], "page.html")]],
      ],
    ];
    for (const t of [targets.pb, targets.hb])
      for (const [key, entries] of uploads) {
        const res = await api(t, "POST", records(), form(entries));
        state[t.name][key] = await res.json();
      }
  });

  test("a text file is an attachment with the sandbox headers", async () => {
    const [pb] = await same(
      (t) => fetch(fileUrl(t, "txt")),
      200,
      SERVED_HEADERS,
    );
    expect(pb.headers["x-frame-options"]).toBeUndefined();
  });

  test("an image is served inline", async () => {
    const [pb] = await same(
      (t) => fetch(fileUrl(t, "png")),
      200,
      SERVED_HEADERS,
    );
    expect(pb.headers["content-disposition"]).toStartWith("inline;");
  });

  test("a pdf is served inline", async () => {
    await same((t) => fetch(fileUrl(t, "pdf")), 200, SERVED_HEADERS);
  });

  test.each(["1", "true", "t", "0", "false", "yes", ""])(
    "?download=%p",
    async (value) => {
      await same(
        (t) => fetch(fileUrl(t, "png", `?download=${value}`)),
        200,
        SERVED_HEADERS,
      );
    },
  );

  test("svg and html never get an inline disposition", async () => {
    for (const key of ["svgExt", "svg", "html"]) {
      const [pb] = await same(
        (t) => fetch(fileUrl(t, key)),
        200,
        SERVED_HEADERS,
      );
      expect(pb.headers["content-disposition"]).toStartWith("attachment;");
    }
  });

  test("an invalid thumb size serves the original", async () => {
    await same(
      (t) => fetch(fileUrl(t, "png", "?thumb=7x7")),
      200,
      SERVED_HEADERS,
    );
  });

  test("a HEAD request", async () => {
    await same(
      (t) => fetch(fileUrl(t, "png"), { method: "HEAD" }),
      200,
      SERVED_HEADERS,
    );
  });

  describe("ServeContent", () => {
    const get = (key: string, headers: Record<string, string>) => (t: Target) =>
      fetch(fileUrl(t, key), { headers });
    const future = "Fri, 01 Jan 2100 00:00:00 GMT";

    test("a 200 advertises ranges and Last-Modified", async () => {
      const [pb] = await same(get("png", {}), 200, SERVED_HEADERS);
      expect(pb.headers["accept-ranges"]).toBe("bytes");
      expect(pb.headers["last-modified"]).toMatch(/ GMT$/);
    });

    test("If-Modified-Since newer than the file is 304", async () => {
      await same(
        get("png", { "if-modified-since": future }),
        304,
        SERVED_HEADERS,
      );
    });

    test("If-Modified-Since older than the file is 200", async () => {
      await same(
        get("png", { "if-modified-since": "Thu, 01 Jan 1970 00:00:01 GMT" }),
        200,
        SERVED_HEADERS,
      );
    });

    test.each([
      ["bytes=0-3", 206],
      ["bytes=2-", 206],
      ["bytes=-4", 206],
      ["bytes=0-999999", 206],
      ["bytes=999999-", 416],
      ["bytes=5-2", 416],
      ["bytes=abc", 416],
      ["items=0-3", 416],
    ])("Range %p", async (range, status) => {
      const [pb] = await same(get("png", { range }), status, [
        ...SERVED_HEADERS,
        "content-length",
      ]);
      if (status === 416)
        expect(pb.headers["content-type"]).toBe("text/plain; charset=utf-8");
    });

    const past = "Thu, 01 Jan 1970 00:00:01 GMT";
    test.each([
      [{ "if-match": "*" }, 200],
      [{ "if-match": '"abc"' }, 412],
      [{ "if-match": "garbage, *" }, 412],
      [{ "if-match": '"abc", *' }, 200],
      [{ "if-unmodified-since": future }, 200],
      [{ "if-unmodified-since": past }, 412],
      [{ "if-match": "*", "if-unmodified-since": past }, 200],
      [{ "if-none-match": "*" }, 304],
      [{ "if-none-match": '"abc", *' }, 304],
      [{ "if-none-match": '"abc"' }, 200],
      [{ "if-none-match": '"abc"', "if-modified-since": future }, 200],
      [{ "if-range": '"abc"', range: "bytes=0-3" }, 200],
      [{ range: "bytes=0-9223372036854775807" }, 206],
      [{ range: "bytes=0-9223372036854775808" }, 416],
      [{ range: "bytes=-9223372036854775808" }, 416],
      [{ range: "bytes=0-1,0-1000" }, 200],
    ])("preconditions %p", async (headers, status) => {
      await same(get("png", headers), status, [
        ...SERVED_HEADERS,
        "content-length",
      ]);
    });

    test.each(["GET", "HEAD"])(
      "%s with several ranges is multipart/byteranges",
      async (method) => {
        const answer = async (t: Target) => {
          const res = await fetch(fileUrl(t, "txt"), {
            method,
            headers: { range: "bytes=0-1,4-5, -2" },
          });
          const boundary = res.headers
            .get("content-type")!
            .replace("multipart/byteranges; boundary=", "");
          return {
            status: res.status,
            boundary: boundary.length,
            length: res.headers.get("content-length"),
            body: (await res.text()).replaceAll(boundary, "B"),
          };
        };
        const pb = await answer(targets.pb);
        expect(pb.status).toBe(206);
        expect(await answer(targets.hb)).toEqual(pb);
      },
    );

    test("If-Range with another date ignores the range", async () => {
      await same(
        get("png", {
          range: "bytes=0-3",
          "if-range": "Thu, 01 Jan 1970 00:00:01 GMT",
        }),
        200,
        SERVED_HEADERS,
      );
    });
  });

  test("unknown filename", async () => {
    await same(
      (t) => fetch(fileUrl(t, "txt", "", "missing_abcdefghij.txt")),
      404,
      SERVED_HEADERS,
    );
  });

  test("unknown record", async () => {
    await same(
      (t) =>
        fetch(
          `${t.url}/api/files/${id(t, "collection")}/nonexistent12345/a.txt`,
        ),
      404,
      SERVED_HEADERS,
    );
  });

  test("unknown collection", async () => {
    await same(
      (t) => fetch(`${t.url}/api/files/nope/${record(t, "txt").id}/a.txt`),
      404,
      SERVED_HEADERS,
    );
  });

  describe("untrusted path parameters", () => {
    const rawGet = (t: Target, path: string) =>
      new Promise<Response>((done, fail) => {
        const chunks: Buffer[] = [];
        const { hostname, port } = new URL(t.url);
        Bun.connect({
          hostname,
          port: Number(port),
          socket: {
            open(socket) {
              socket.write(
                `GET ${path} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`,
              );
            },
            data(_, data) {
              chunks.push(Buffer.from(data));
            },
            close() {
              const text = Buffer.concat(chunks).toString();
              const [head, ...rest] = text.split("\r\n\r\n");
              const [statusLine, ...lines] = head!.split("\r\n");
              const status = Number(/^HTTP\/1\.1 (\d+)/.exec(statusLine!)?.[1]);
              const headers = lines.map((l): [string, string] => {
                const [k, ...v] = l.split(":");
                return [k!.toLowerCase(), v.join(":").trim()];
              });
              done(new Response(rest.join("\r\n\r\n"), { status, headers }));
            },
            error: (_, err) => fail(err),
          },
        });
      });

    const cases: [string, (t: Target) => string][] = [
      [
        "encoded slashes in the filename",
        (t) =>
          `/api/files/${id(t, "collection")}/${record(t, "txt").id}/..%2f..%2f..%2fdata.db`,
      ],
      [
        "encoded backslash",
        (t) =>
          `/api/files/${id(t, "collection")}/${record(t, "txt").id}/..%5c..%5cdata.db`,
      ],
      [
        "NUL in the filename",
        (t) =>
          `/api/files/${id(t, "collection")}/${record(t, "txt").id}/a%00.txt`,
      ],
      [
        "traversal in the record id",
        (t) => `/api/files/${id(t, "collection")}/..%2f..%2f/data.db`,
      ],
      ["traversal in the collection", (t) => `/api/files/..%2f..%2f/x/data.db`],
    ];
    test.each(cases)("%s", async (_, path) => {
      const [pb, hb] = await both((t) => rawGet(t, path(t)));
      expect(pb.status).toBe(404);
      expectSame(pb, hb);
    });

    // Bun collapses dot segments before routing and Go's mux redirects them, so only Heybe is checked
    test.each(["%2e%2e", "..", "."])(
      "dot segment %p never serves a file",
      async (seg) => {
        const res = await rawGet(
          targets.hb,
          `/api/files/${id(targets.hb, "collection")}/${record(targets.hb, "txt").id}/${seg}`,
        );
        expect(res.status).toBe(404);
      },
    );
  });
});

describe("protected files", () => {
  const login = async (t: Target, email: string) => {
    const res = await api(
      t,
      "POST",
      "/api/collections/users/auth-with-password",
      { identity: email, password: "1234567890" },
      null,
    );
    return ((await res.json()) as Json).token as string;
  };
  const fileToken = async (t: Target, auth: string | null) =>
    (
      (await (
        await api(t, "POST", "/api/files/token", undefined, auth)
      ).json()) as Json
    ).token as string;

  beforeAll(async () => {
    for (const t of [targets.pb, targets.hb]) {
      for (const email of ["allowed@example.com", "other@example.com"]) {
        const res = await api(t, "POST", "/api/collections/users/records", {
          email,
          password: "1234567890",
          passwordConfirm: "1234567890",
        });
        if (!res.ok) throw new Error(`${t.name}: ${await res.text()}`);
      }
      const col = await api(t, "POST", "/api/collections", {
        name: "secrets",
        type: "base",
        viewRule: '@request.auth.email = "allowed@example.com"',
        createRule: "",
        fields: [{ name: "doc", type: "file", maxSelect: 1, protected: true }],
      });
      if (!col.ok) throw new Error(`${t.name}: ${await col.text()}`);
      state[t.name].secrets = ((await col.json()) as Json).id;
      const rec = await api(
        t,
        "POST",
        "/api/collections/secrets/records",
        form([["doc", fixture("a.txt")]]),
      );
      state[t.name].secret = await rec.json();
      state[t.name].allowed = await login(t, "allowed@example.com");
      state[t.name].other = await login(t, "other@example.com");
    }
  });

  const secretUrl = (t: Target, query = "") => {
    const r = state[t.name].secret as Json;
    return `${t.url}/api/files/${state[t.name].secrets}/${r.id}/${r.doc}${query}`;
  };

  test("without a token", async () => {
    await same((t) => fetch(secretUrl(t)), 404, SERVED_HEADERS);
  });

  test("a garbage token", async () => {
    await same((t) => fetch(secretUrl(t, "?token=garbage")), 404);
  });

  test("a user who passes the view rule", async () => {
    await same(
      async (t) =>
        fetch(
          secretUrl(
            t,
            `?token=${await fileToken(t, state[t.name].allowed as string)}`,
          ),
        ),
      200,
      SERVED_HEADERS,
    );
  });

  test("a user who fails the view rule", async () => {
    await same(
      async (t) =>
        fetch(
          secretUrl(
            t,
            `?token=${await fileToken(t, state[t.name].other as string)}`,
          ),
        ),
      404,
    );
  });

  test("a superuser token", async () => {
    await same(
      async (t) =>
        fetch(secretUrl(t, `?token=${await fileToken(t, t.superToken)}`)),
      200,
    );
  });

  test("an auth token is not a file token", async () => {
    await same(
      (t) => fetch(secretUrl(t, `?token=${state[t.name].allowed}`)),
      404,
    );
  });

  test("the Authorization header does not unlock the file", async () => {
    await same(
      (t) => fetch(secretUrl(t), { headers: { authorization: t.superToken } }),
      404,
    );
  });

  describe("POST /api/files/token", () => {
    const claims = (token: string) =>
      JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());

    test("a guest", async () => {
      await same(
        (t) => api(t, "POST", "/api/files/token", undefined, null),
        401,
      );
    });

    test("a user", async () => {
      await same(
        (t) =>
          api(
            t,
            "POST",
            "/api/files/token",
            undefined,
            state[t.name].allowed as string,
          ),
        200,
      );
    });

    test("claims and duration match PB", async () => {
      const [a, b] = await Promise.all(
        [targets.pb, targets.hb].map(async (t) =>
          claims(await fileToken(t, state[t.name].allowed as string)),
        ),
      );
      expect(Object.keys(b)).toEqual(Object.keys(a));
      expect(b.type).toBe("file");
      expect(b.collectionId).toBeString();
      expect(b.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(180);
      expect(a.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(180);
    });

    test("a superuser", async () => {
      await same((t) => api(t, "POST", "/api/files/token"), 200);
    });
  });
});

describe("sniffed content types", () => {
  const probes: [string, string | Uint8Array<ArrayBuffer>][] = [
    [
      "invalid utf-8 after 1024 bytes",
      new Uint8Array([...new Uint8Array(1100).fill(97), 0xe9]),
    ],
    ["invalid utf-8 before 1024 bytes", new Uint8Array([97, 0xe9])],
    ["html with a newline after the tag name", "<html\n<body>"],
    ["div with a tab", "<div\tclass=x>"],
    ["html with a form feed", "<p\f>"],
    ["html tag without a terminator", "<html"],
    ["a comment first", "<!--x--><p>"],
    ["an unterminated comment", "<!-- x -->"],
    ["a bom before html", "\ufeff<html>"],
    ["mixed case html", "<hTmL>"],
    ["a doctype", "<!doctype html><title>x</title>"],
    ["html then meta charset", '<html><meta charset="iso-8859-1">'],
    [
      "html then meta http-equiv",
      '<html><meta http-equiv="Content-Type" content="text/html; charset=windows-1251">',
    ],
    [
      "html then meta content only",
      '<html><meta content="text/html; charset=windows-1251">',
    ],
    [
      "html comment then meta",
      '<html><!-- <meta charset="x"> --><meta charset="big5">',
    ],
    ["html then body then meta", '<body><meta charset="iso-8859-1">'],
    ["meta charset", '<meta charset="iso-8859-1">'],
    [
      "meta http-equiv content",
      '<meta http-equiv="Content-Type" content="text/html; charset=windows-1251">',
    ],
    [
      "meta content without the pragma",
      '<meta content="text/html; charset=windows-1251">',
    ],
    ["meta after body", '<body><meta charset="iso-8859-1">'],
    ["plain xml", '<?xml version="1.0"?><a/>'],
    ["xml with an encoding", '<?xml version="1.0" encoding="ISO-8859-1"?><a/>'],
    ["xml with a leading newline", '\n<?xml version="1.0"?><a/>'],
    [
      "xhtml doctype",
      '<?xml version="1.0"?>\n<!DOCTYPE  html PUBLIC "x"><html>',
    ],
    [
      "xhtml namespace",
      '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml">',
    ],
  ];
  const ids: Record<Target["name"], string[]> = { pocketbase: [], heybe: [] };

  beforeAll(async () => {
    for (const t of [targets.pb, targets.hb])
      for (const [i, [, content]] of probes.entries()) {
        const res = await api(
          t,
          "POST",
          records(),
          form([["file", new File([content], `probe${i}.dat`)]]),
        );
        ids[t.name].push(((await res.json()) as Json).file);
        state[t.name][`probe${i}`] = await api(t, "GET", records("?perPage=1"));
      }
  });

  test.each(probes.map(([label], i) => [label, i] as const))(
    "%s",
    async (_, i) => {
      await same(
        (t) => {
          const name = ids[t.name][i];
          const dir = readdirSync(join(t.dir, "storage", id(t, "collection")));
          const recordId = dir.find((d) =>
            existsSync(join(t.dir, "storage", id(t, "collection"), d, name!)),
          );
          return fetch(
            `${t.url}/api/files/${id(t, "collection")}/${recordId}/${name}`,
          );
        },
        200,
        ["content-disposition"],
      );
    },
  );
});

describe("thumbnails", () => {
  const SIZES = ["60x30", "0x40", "50x0", "80x40t", "80x40b", "80x40f"];
  const THUMB_HEADERS = [
    "content-disposition",
    "content-security-policy",
    "cache-control",
    "x-content-type-options",
    "x-frame-options",
  ];

  const image = (format: "png" | "jpeg" | "gif") =>
    sharp({
      create: { width: 200, height: 100, channels: 3, background: "#c81e1e" },
    })
      [format]()
      .toBuffer();

  const imageInfo = async (t: Target, url: string) => {
    const res = await fetch(url);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const headers = Object.fromEntries(
      [...res.headers].filter(([k]) =>
        ["content-type", ...THUMB_HEADERS].includes(k),
      ),
    );
    const meta =
      res.ok && res.headers.get("content-type")?.startsWith("image/")
        ? await sharp(bytes).metadata()
        : null;
    return {
      status: res.status,
      headers: maskNames(headers),
      size: meta ? [meta.width, meta.height, meta.format] : bytes.length,
    };
  };

  const sameImage = async (url: (t: Target) => string, status = 200) => {
    const [pb, hb] = await Promise.all([
      imageInfo(targets.pb, url(targets.pb)),
      imageInfo(targets.hb, url(targets.hb)),
    ]);
    expect(pb.status).toBe(status);
    expect(hb).toEqual(pb);
    return pb;
  };

  const picUrl = (t: Target, key: string, query: string) => {
    const r = record(t, key);
    return `${t.url}/api/files/${id(t, "pics")}/${r.id}/${r.img}${query}`;
  };

  beforeAll(async () => {
    const png = await image("png");
    const jpeg = await image("jpeg");
    const gif = await image("gif");
    for (const t of [targets.pb, targets.hb]) {
      const col = await api(t, "POST", "/api/collections", {
        name: "pics",
        type: "base",
        viewRule: "",
        createRule: "",
        fields: [{ name: "img", type: "file", maxSelect: 1, thumbs: SIZES }],
      });
      if (!col.ok) throw new Error(`${t.name}: ${await col.text()}`);
      state[t.name].pics = ((await col.json()) as Json).id;
      const locked = await api(t, "POST", "/api/collections", {
        name: "lockedpics",
        type: "base",
        createRule: "",
        fields: [
          {
            name: "secret",
            type: "file",
            maxSelect: 1,
            protected: true,
            thumbs: SIZES,
          },
        ],
      });
      if (!locked.ok) throw new Error(`${t.name}: ${await locked.text()}`);
      state[t.name].lockedpics = ((await locked.json()) as Json).id;
      const uploads: [string, string, Uint8Array][] = [
        ["png", "img", png],
        ["jpeg", "img", jpeg],
        ["gif", "img", gif],
        ["text", "img", new TextEncoder().encode("plain text")],
        ["corrupt", "img", new TextEncoder().encode("\x89PNG\r\n\x1a\nnope")],
        ["secret", "secret", png],
      ];
      for (const [key, field, bytes] of uploads) {
        const name =
          key === "text"
            ? "note.txt"
            : `${key}.${key === "jpeg" ? "jpg" : "png"}`;
        const res = await api(
          t,
          "POST",
          `/api/collections/${field === "secret" ? "lockedpics" : "pics"}/records`,
          form([
            [
              field,
              new File(
                [new Uint8Array(bytes)],
                key === "gif" ? "pic.gif" : name,
              ),
            ],
          ]),
        );
        if (!res.ok) throw new Error(`${t.name}: ${await res.text()}`);
        state[t.name][key] = await res.json();
      }
    }
  });

  test.each(SIZES)("an allowed size %s", async (size) => {
    const info = await sameImage((t) => picUrl(t, "png", `?thumb=${size}`));
    expect(info.size).not.toEqual([200, 100, "png"]);
  });

  test("the default 100x100 size is allowed without being listed", async () => {
    const info = await sameImage((t) => picUrl(t, "png", "?thumb=100x100"));
    expect(info.size).toEqual([100, 100, "png"]);
  });

  test("a jpeg and a gif keep their format", async () => {
    const jpeg = await sameImage((t) => picUrl(t, "jpeg", "?thumb=60x30"));
    expect(jpeg.size).toEqual([60, 30, "jpeg"]);
    const gif = await sameImage((t) => picUrl(t, "gif", "?thumb=60x30"));
    expect(gif.size).toEqual([60, 30, "gif"]);
  });

  test("a second request is served from the stored thumb", async () => {
    await sameImage((t) => picUrl(t, "png", "?thumb=60x30"));
  });

  test.each(["7x7", "60x31", "0x0", "bad"])(
    "a size that is not allowed (%s) serves the original",
    async (size) => {
      const info = await sameImage((t) => picUrl(t, "png", `?thumb=${size}`));
      expect(info.size).toEqual([200, 100, "png"]);
    },
  );

  test("a non-image serves the original", async () => {
    await sameImage((t) => {
      const r = record(t, "text");
      return `${t.url}/api/files/${id(t, "pics")}/${r.id}/${r.img}?thumb=60x30`;
    });
  });

  test("a corrupt image serves the original", async () => {
    await sameImage((t) => picUrl(t, "corrupt", "?thumb=60x30"));
  });

  test("a protected file thumb needs a token", async () => {
    const tokens: Record<string, string> = {};
    for (const t of [targets.pb, targets.hb]) {
      const res = await api(t, "POST", "/api/files/token");
      tokens[t.name] = ((await res.json()) as Json).token;
    }
    const url = (t: Target, query: string) => {
      const r = record(t, "secret");
      return `${t.url}/api/files/${id(t, "lockedpics")}/${r.id}/${r.secret}${query}`;
    };
    await sameImage((t) => url(t, "?thumb=60x30"), 404);
    const info = await sameImage((t) =>
      url(t, `?thumb=60x30&token=${tokens[t.name]}`),
    );
    expect(info.size).toEqual([60, 30, "png"]);
  });
});
