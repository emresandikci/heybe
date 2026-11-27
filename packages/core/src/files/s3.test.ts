import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { App } from "../app";
import { serve } from "../http/server";
import type { S3Config } from "../settings";
import { createEvent } from "../http/router";
import { serveStoredFile } from "../http/routes/files";
import { fakeClock } from "../test-clock";
import { testApp } from "../test-app";
import { S3_TIMEOUT_MS, s3Filesystem } from "./s3";
import { type FakeS3, startFakeS3 } from "./test-s3";

const enc = (s: string) => new TextEncoder().encode(s);

let s3: FakeS3;
let config: S3Config;

beforeEach(async () => {
  s3 = await startFakeS3({ now: () => new Date("2026-01-02T03:04:05Z") });
  config = {
    enabled: true,
    bucket: "hb",
    region: "us-east-1",
    endpoint: s3.endpoint,
    accessKey: "key",
    secret: "secret",
    forcePathStyle: true,
  };
});

afterEach(() => s3.stop());

describe("s3Filesystem", () => {
  test("write, file, exists, list, delete, deletePrefix round trip", async () => {
    const fs = s3Filesystem(config);
    await fs.write("hbc_1/a/x.txt", enc("hello"));
    await fs.write("hbc_1/a/y.json", new Blob(["{}"]), "application/json");
    await fs.write("hbc_1/b/z.txt", enc("z"));
    await fs.write("hbc_10/a/w.txt", enc("w"));

    expect(s3.objects("hb").get("hbc_1/a/x.txt")?.type).toBe(
      "text/plain; charset=utf-8",
    );
    expect(s3.objects("hb").get("hbc_1/a/y.json")?.type).toStartWith(
      "application/json",
    );

    const file = await fs.file("hbc_1/a/x.txt");
    expect(await file?.blob.text()).toBe("hello");
    expect(await file?.blob.slice(1, 3).text()).toBe("el");
    expect(file?.size).toBe(5);
    expect(file?.modified).toEqual(new Date("2026-01-02T03:04:05Z"));

    expect(await fs.exists("hbc_1/a/x.txt")).toBe(true);
    expect(await fs.exists("hbc_1/a/missing.txt")).toBe(false);

    const list = await fs.list("hbc_1/");
    expect(list.map((f) => f.key)).toEqual([
      "hbc_1/a/x.txt",
      "hbc_1/a/y.json",
      "hbc_1/b/z.txt",
    ]);
    expect(list[0]).toEqual({
      key: "hbc_1/a/x.txt",
      size: 5,
      modified: new Date("2026-01-02T03:04:05Z"),
    });

    await fs.delete("hbc_1/a/x.txt");
    expect(await fs.file("hbc_1/a/x.txt")).toBeNull();

    await fs.deletePrefix("hbc_1/");
    expect([...s3.objects("hb").keys()]).toEqual(["hbc_10/a/w.txt"]);
  });

  test("keys with spaces, +, %, unicode and thumbs_ prefixes round trip", async () => {
    const fs = s3Filesystem(config);
    const keys = [
      "hbc_1/r 1/a b+c%20d.txt",
      "hbc_1/r 1/ünï çødé 漢字.txt",
      "hbc_1/r 1/thumbs_a b+c.png/100x100_a b+c.png",
    ];
    for (const key of keys) await fs.write(key, enc(key));
    expect([...s3.objects("hb").keys()].sort()).toEqual([...keys].sort());
    for (const key of keys)
      expect(await (await fs.file(key))?.blob.text()).toBe(key);
    expect((await fs.list("hbc_1/r 1/")).map((f) => f.key)).toEqual(
      [...keys].sort(),
    );
    expect((await fs.list("hbc_1/r 1/thumbs_")).map((f) => f.key)).toEqual([
      keys[2]!,
    ]);
    await fs.deletePrefix("hbc_1/r 1/thumbs_a b+c.png/");
    expect(await fs.exists(keys[2]!)).toBe(false);
    await fs.deletePrefix("hbc_1/r 1/");
    expect(s3.objects("hb").size).toBe(0);
  });

  test("list pages past 1000 keys", async () => {
    const objects = s3.objects("hb");
    for (let i = 0; i < 1001; i++)
      objects.set(`p/${String(i).padStart(4, "0")}`, {
        body: new Uint8Array(1),
        type: "application/octet-stream",
        modified: new Date(),
      });
    const list = await s3Filesystem(config).list("p/");
    expect(list).toHaveLength(1001);
    expect(list.at(-1)?.key).toBe("p/1000");
    expect(s3.requests.filter((r) => r.method === "GET")).toHaveLength(2);
  });

  test("a write past 5 MiB goes multipart and reads back intact", async () => {
    const path = join(tmpdir(), `hb-s3-${crypto.randomUUID()}.bin`);
    const data = crypto.getRandomValues(new Uint8Array(65536));
    await Bun.write(path, new Blob(Array(200).fill(data)));
    try {
      const fs = s3Filesystem(config);
      await fs.write("big.bin", Bun.file(path));
      expect(s3.requests.some((r) => r.path.includes("?uploads"))).toBe(true);
      const stored = await fs.file("big.bin");
      expect(stored?.size).toBe(200 * 65536);
      expect(
        new Bun.CryptoHasher("sha256")
          .update(await stored!.blob.bytes())
          .digest("hex"),
      ).toBe(
        new Bun.CryptoHasher("sha256")
          .update(await Bun.file(path).bytes())
          .digest("hex"),
      );
    } finally {
      await rm(path, { force: true });
    }
  });

  test("deletePrefix deletes past a failure and rejects with the first", async () => {
    const fs = s3Filesystem(config);
    for (const k of ["p/a", "p/b", "p/c"]) await fs.write(k, enc(k));
    const push = s3.requests.push.bind(s3.requests);
    s3.requests.push = (...items) => {
      if (items[0]?.method === "DELETE" && items[0].path.endsWith("/p/a"))
        s3.failNext(500, "InternalError");
      return push(...items);
    };
    await expect(fs.deletePrefix("p/")).rejects.toThrow("InternalError error");
    expect([...s3.objects("hb").keys()]).toEqual(["p/a"]);
  });

  test("file of a missing key is null", async () => {
    expect(await s3Filesystem(config).file("hbc_1/a/missing.txt")).toBeNull();
  });

  test("an S3 that never answers rejects after the timeout", async () => {
    const clock = fakeClock();
    const fs = s3Filesystem(config, clock.timers);
    await fs.write("a.txt", enc("hello"));
    s3.hang();
    const settled = (p: Promise<unknown>) =>
      p.then(
        () => "resolved",
        (err: Error) => err.message,
      );
    const app = testApp();
    try {
      const results = Promise.all([
        settled(fs.file("a.txt")),
        settled(
          serveStoredFile(
            createEvent(app, new Request("http://x/"), {}),
            fs,
            "a.txt",
            "a.txt",
          ),
        ),
      ]);
      clock.advance(S3_TIMEOUT_MS - 1);
      expect(clock.pending()).toBe(2);
      clock.advance(1);
      expect(await results).toEqual([
        "S3 request timed out",
        "S3 request timed out",
      ]);
    } finally {
      app.close();
    }
  });

  test("a GET body that stalls after the headers times out", async () => {
    const clock = fakeClock();
    const fs = s3Filesystem(config, clock.timers);
    await fs.write("a.txt", enc("hello"));
    s3.bodies("stalled");
    const file = (await fs.open!("a.txt", false))!;
    const reader = file.read(0, 5).getReader();
    expect((await reader.read()).value).toEqual(enc("h"));
    const read = reader.read();
    // the stream may already be pulling ahead with its timer set
    if (clock.pending() === 0) await clock.scheduled();
    clock.advance(S3_TIMEOUT_MS);
    await expect(read).rejects.toThrow("S3 request timed out");
  });

  test("a GET without Content-Length takes the size from the stat", async () => {
    const fs = s3Filesystem(config);
    await fs.write("a.txt", enc("hello"));
    s3.bodies("chunked");
    const file = (await fs.open!("a.txt", false))!;
    expect(file.size).toBe(5);
    expect(await new Response(file.read(0, 5)).text()).toBe("hello");
  });

  test("a 500 from S3 rejects write and list with the S3 message", async () => {
    const fs = s3Filesystem(config);
    s3.failNext(500, "InternalError");
    await expect(fs.write("a.txt", enc("a"))).rejects.toThrow(
      "InternalError error",
    );
    s3.failNext(500, "InternalError");
    await expect(fs.list("")).rejects.toThrow("InternalError error");
    s3.failNext(500, "InternalError");
    await expect(fs.file("a.txt")).rejects.toThrow();
  });

  test("a refused connection rejects", async () => {
    const fs = s3Filesystem(config);
    await s3.stop();
    await expect(fs.write("a.txt", enc("a"))).rejects.toThrow();
    await expect(fs.file("a.txt")).rejects.toThrow();
    await expect(fs.list("")).rejects.toThrow();
  });
});

describe("app.files on S3", () => {
  let app: App;
  let server: { url: string; stop(): Promise<void> };

  beforeEach(async () => {
    app = testApp();
    await app.collections.save({
      name: "docs",
      viewRule: "",
      createRule: "",
      fields: [{ name: "doc", type: "file", maxSelect: 1, maxSize: 1000000 }],
    } as never);
    server = await serve(app, { host: "127.0.0.1", port: 0 });
  });

  afterEach(async () => {
    await server.stop();
    app.close();
  });

  test("app.files switches to S3 after a settings save and back", async () => {
    await app.settings.update({ s3: config });
    const docs = app.collections.find("docs")!;
    const png = new Uint8Array(
      await sharp({
        create: { width: 4, height: 4, channels: 3, background: "#f00" },
      })
        .png()
        .toBuffer(),
    );
    const r = await app.records("docs").create({
      doc: new File([png], "a.png"),
    });
    const key = `${docs.id}/${r.id}/${r.doc}`;
    expect(s3.objects("hb").has(key)).toBe(true);

    const res = await fetch(`${server.url}/api/files/docs/${r.id}/${r.doc}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("last-modified")).toBe(
      "Fri, 02 Jan 2026 03:04:05 GMT",
    );
    expect(res.headers.get("content-length")).toBe(String(png.length));
    expect(await res.bytes()).toEqual(png);

    const ranged = await fetch(
      `${server.url}/api/files/docs/${r.id}/${r.doc}`,
      { headers: { range: "bytes=0-3" } },
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-length")).toBe("4");
    expect(ranged.headers.get("transfer-encoding")).toBeNull();
    expect(await ranged.bytes()).toEqual(png.slice(0, 4));

    const head = await fetch(`${server.url}/api/files/docs/${r.id}/${r.doc}`, {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(png.length));

    const thumb = await fetch(
      `${server.url}/api/files/docs/${r.id}/${r.doc}?thumb=100x100`,
    );
    expect(thumb.status).toBe(200);
    expect(
      s3
        .objects("hb")
        .has(`${docs.id}/${r.id}/thumbs_${r.doc}/100x100_${r.doc}`),
    ).toBe(true);

    await app.settings.update({ s3: { enabled: false } });
    expect(await app.files.file(key)).toBeNull();
    const local = await app.records("docs").create({
      doc: new File(["hi"], "b.txt"),
    });
    expect(
      await Bun.file(
        join(
          app.dataDir,
          "storage",
          docs.id,
          local.id as string,
          local.doc as string,
        ),
      ).exists(),
    ).toBe(true);
  });

  const download = async (
    body: string,
    init: RequestInit,
  ): Promise<{ res: Response; text: string }> => {
    await app.settings.update({ s3: config });
    const r = await app.records("docs").create({
      doc: new File([body], "a.txt"),
    });
    s3.requests.length = 0;
    const res = await fetch(
      `${server.url}/api/files/docs/${r.id}/${r.doc}`,
      init,
    );
    return { res, text: await res.text() };
  };
  const sent = () => s3.requests.map((q) => [q.method, q.range]);

  test.each([
    ["GET", {}, 200, [["GET", null]]],
    [
      "GET",
      { range: "bytes=1-3" },
      206,
      [
        ["HEAD", null],
        ["GET", "bytes=1-3"],
      ],
    ],
    [
      "GET",
      { range: "bytes=0-0,2-3" },
      206,
      [
        ["HEAD", null],
        ["GET", "bytes=0-0"],
        ["GET", "bytes=2-3"],
      ],
    ],
    ["HEAD", {}, 200, [["HEAD", null]]],
    ["GET", { "if-none-match": "*" }, 304, [["HEAD", null]]],
    ["GET", { "if-match": '"x"' }, 412, [["HEAD", null]]],
    ["GET", { range: "bytes=50-" }, 416, [["HEAD", null]]],
  ])(
    "%s %p answers %d with S3 requests %p",
    async (method, headers, status, requests) => {
      const { res, text } = await download("hello world", { method, headers });
      expect(res.status).toBe(status);
      expect(sent()).toEqual(requests);
      if (status === 200 && method === "GET") {
        expect(text).toBe("hello world");
        expect(res.headers.get("content-length")).toBe("11");
        expect(res.headers.get("content-type")).toBe(
          "text/plain; charset=utf-8",
        );
      }
      if (method === "HEAD")
        expect(res.headers.get("content-length")).toBe("11");
      const range = (headers as { range?: string }).range;
      if (range === "bytes=1-3") {
        expect(text).toBe("ell");
        expect(res.headers.get("content-length")).toBe("3");
      }
      if (range === "bytes=0-0,2-3") {
        expect(text).toContain("\r\n\r\nh\r\n");
        expect(text).toContain("\r\n\r\nll\r\n");
      }
    },
  );

  test("a range of a large file is one ranged GET, not the prefix", async () => {
    const big = "x".repeat(300_000) + "0123456789";
    const { res, text } = await download(big, {
      headers: { range: "bytes=300000-300009" },
    });
    expect(res.status).toBe(206);
    expect(text).toBe("0123456789");
    expect(sent()).toEqual([
      ["HEAD", null],
      ["GET", "bytes=300000-300009"],
    ]);
  });

  test("a large file streams in one GET", async () => {
    const big = "y".repeat(300_000);
    const { res, text } = await download(big, {});
    expect(res.status).toBe(200);
    expect(text).toBe(big);
    expect(sent()).toEqual([["GET", null]]);
  });

  test("a thumb of an S3 original takes its type from the stat, not a body read", async () => {
    await app.settings.update({ s3: config });
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: "#f00" },
    })
      .png()
      .toBuffer();
    const r = await app.records("docs").create({
      doc: new File([png], "a.png"),
    });
    const url = `${server.url}/api/files/docs/${r.id}/${r.doc}?thumb=100x100`;
    expect((await fetch(url)).status).toBe(200);
    s3.requests.length = 0;
    expect((await fetch(url)).status).toBe(200);
    expect(sent()).toEqual([
      ["HEAD", null],
      ["HEAD", null],
      ["GET", null],
    ]);
  });

  test("a record file download while the fake S3 is stopped answers 404 without hanging", async () => {
    await app.settings.update({ s3: config });
    const r = await app.records("docs").create({
      doc: new File(["hello"], "a.txt"),
    });
    await s3.stop();
    const res = await fetch(`${server.url}/api/files/docs/${r.id}/${r.doc}`);
    expect(res.status).toBe(404);
  });

  test("newBackupsFilesystem is local <dataDir>/backups unless backups S3 is enabled", async () => {
    await app.newBackupsFilesystem().write("a.zip", enc("a"));
    expect(await Bun.file(join(app.dataDir, "backups/a.zip")).exists()).toBe(
      true,
    );
    await app.settings.update({ backups: { s3: { ...config, bucket: "bk" } } });
    await app.newBackupsFilesystem().write("b.zip", enc("b"));
    expect(s3.objects("bk").has("b.zip")).toBe(true);
    expect(s3.objects("hb").size).toBe(0);
  });
});
