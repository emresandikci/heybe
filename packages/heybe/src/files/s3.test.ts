import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { App } from "../app";
import { serve } from "../http/server";
import type { S3Config } from "../settings";
import { testApp } from "../test-app";
import { s3Filesystem } from "./s3";
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
    await fs.write("pbc_1/a/x.txt", enc("hello"));
    await fs.write("pbc_1/a/y.json", new Blob(["{}"]), "application/json");
    await fs.write("pbc_1/b/z.txt", enc("z"));
    await fs.write("pbc_10/a/w.txt", enc("w"));

    expect(s3.objects("hb").get("pbc_1/a/x.txt")?.type).toBe(
      "text/plain; charset=utf-8",
    );
    expect(s3.objects("hb").get("pbc_1/a/y.json")?.type).toStartWith(
      "application/json",
    );

    const file = await fs.file("pbc_1/a/x.txt");
    expect(await file?.blob.text()).toBe("hello");
    expect(await file?.blob.slice(1, 3).text()).toBe("el");
    expect(file?.size).toBe(5);
    expect(file?.modified).toEqual(new Date("2026-01-02T03:04:05Z"));

    expect(await fs.exists("pbc_1/a/x.txt")).toBe(true);
    expect(await fs.exists("pbc_1/a/missing.txt")).toBe(false);

    const list = await fs.list("pbc_1/");
    expect(list.map((f) => f.key)).toEqual([
      "pbc_1/a/x.txt",
      "pbc_1/a/y.json",
      "pbc_1/b/z.txt",
    ]);
    expect(list[0]).toEqual({
      key: "pbc_1/a/x.txt",
      size: 5,
      modified: new Date("2026-01-02T03:04:05Z"),
    });

    await fs.delete("pbc_1/a/x.txt");
    expect(await fs.file("pbc_1/a/x.txt")).toBeNull();

    await fs.deletePrefix("pbc_1/");
    expect([...s3.objects("hb").keys()]).toEqual(["pbc_10/a/w.txt"]);
  });

  test("keys with spaces, +, %, unicode and thumbs_ prefixes round trip", async () => {
    const fs = s3Filesystem(config);
    const keys = [
      "pbc_1/r 1/a b+c%20d.txt",
      "pbc_1/r 1/ünï çødé 漢字.txt",
      "pbc_1/r 1/thumbs_a b+c.png/100x100_a b+c.png",
    ];
    for (const key of keys) await fs.write(key, enc(key));
    expect([...s3.objects("hb").keys()].sort()).toEqual([...keys].sort());
    for (const key of keys)
      expect(await (await fs.file(key))?.blob.text()).toBe(key);
    expect((await fs.list("pbc_1/r 1/")).map((f) => f.key)).toEqual(
      [...keys].sort(),
    );
    expect((await fs.list("pbc_1/r 1/thumbs_")).map((f) => f.key)).toEqual([
      keys[2]!,
    ]);
    await fs.deletePrefix("pbc_1/r 1/thumbs_a b+c.png/");
    expect(await fs.exists(keys[2]!)).toBe(false);
    await fs.deletePrefix("pbc_1/r 1/");
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
    const path = join(tmpdir(), `heybe-s3-${crypto.randomUUID()}.bin`);
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
    expect(await s3Filesystem(config).file("pbc_1/a/missing.txt")).toBeNull();
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
      fields: [{ name: "doc", type: "file", maxSelect: 1, maxSize: 100000 }],
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
