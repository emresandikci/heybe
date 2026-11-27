import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { join } from "node:path";
import { createApp } from "../app";
import { checkpointerOf } from "../db";
import { createEvent } from "../http/router";
import { createRouter } from "../http/server";
import { testApp } from "../test-app";
import * as mime from "./mime";
import { mimeExtension, sniffMime } from "./mime";
import { normalizeFilename } from "./name";
import { appFilesystem, fileKey, localFilesystem } from "./storage";

describe("localFilesystem", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hb-fs-"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  test("write, read, delete round trip", async () => {
    const fs = localFilesystem(root);
    expect(await fs.file("hbc_1/abc/a.txt")).toBeNull();
    await fs.write("hbc_1/abc/a.txt", new TextEncoder().encode("hi"));
    expect(await (await fs.file("hbc_1/abc/a.txt"))?.blob.text()).toBe("hi");
    await fs.write("hbc_1/abc/b.txt", new Blob(["yo"]));
    expect(await (await fs.file("hbc_1/abc/b.txt"))?.blob.text()).toBe("yo");
    await fs.delete("hbc_1/abc/a.txt");
    expect(await fs.file("hbc_1/abc/a.txt")).toBeNull();
  });

  test("delete of a missing key rejects", async () => {
    const fs = localFilesystem(root);
    await expect(fs.delete("hbc_1/abc/missing.txt")).rejects.toThrow(
      'blob (key "hbc_1/abc/missing.txt") (code=NotFound)',
    );
  });

  test("exists", async () => {
    const fs = localFilesystem(root);
    await fs.write("hbc_1/abc/a.txt", new Uint8Array([1]));
    expect(await fs.exists("hbc_1/abc/a.txt")).toBe(true);
    expect(await fs.exists("hbc_1/abc/b.txt")).toBe(false);
    expect(await fs.exists("hbc_1/abc")).toBe(false);
  });

  test("list returns files under a prefix sorted by key with size and modified", async () => {
    const fs = localFilesystem(root);
    await fs.write("hbc_1/b/x.txt", new Uint8Array([1, 2]));
    await fs.write("hbc_1/a/thumbs_y.png/10x10_y.png", new Uint8Array([1]));
    await fs.write("hbc_1/a/y.png", new Uint8Array([1, 2, 3]));
    await fs.write("hbc_10/a/z.txt", new Uint8Array([1]));
    await writeFile(
      join(root, "hbc_1/a/y.png.0b8e2c4e-1f5a-4c39-9a51-2c1e5d7f0a11.tmp"),
      "x",
    );
    const when = new Date("2026-01-02T03:04:05Z");
    await utimes(join(root, "hbc_1/a/y.png"), when, when);

    const list = await fs.list("hbc_1/");
    expect(list.map((f) => f.key)).toEqual([
      "hbc_1/a/thumbs_y.png/10x10_y.png",
      "hbc_1/a/y.png",
      "hbc_1/b/x.txt",
    ]);
    expect(list[1]).toEqual({ key: "hbc_1/a/y.png", size: 3, modified: when });
    expect((await fs.list("hbc_1/a/y")).map((f) => f.key)).toEqual([
      "hbc_1/a/y.png",
    ]);
    expect((await fs.list("")).map((f) => f.key)).toHaveLength(4);
    expect(await fs.list("missing/")).toEqual([]);
  });

  test("stored files carry size and modified", async () => {
    const fs = localFilesystem(root);
    await fs.write("hbc_1/abc/a.txt", new Uint8Array([1, 2]));
    const when = new Date("2026-01-02T03:04:05Z");
    await utimes(join(root, "hbc_1/abc/a.txt"), when, when);
    const stored = await fs.file("hbc_1/abc/a.txt");
    expect(stored?.size).toBe(2);
    expect(stored?.modified).toEqual(when);
  });

  test("symlinked dir pointing outside root is rejected for write, file, delete, list", async () => {
    const outside = join(root, "outside");
    const storage = join(root, "storage");
    await mkdir(outside);
    await mkdir(storage);
    await writeFile(join(outside, "a.txt"), "secret");
    await symlink(outside, join(storage, "c1"));
    const fs = localFilesystem(storage);

    const escapes = "escapes storage root";
    await expect(fs.write("c1/a.txt", new Uint8Array([1]))).rejects.toThrow(
      escapes,
    );
    await expect(fs.write("c1/new/b.txt", new Uint8Array([1]))).rejects.toThrow(
      escapes,
    );
    await expect(fs.file("c1/a.txt")).rejects.toThrow(escapes);
    await expect(fs.exists("c1/a.txt")).rejects.toThrow(escapes);
    await expect(fs.delete("c1/a.txt")).rejects.toThrow(escapes);
    await expect(fs.deletePrefix("c1/")).rejects.toThrow(escapes);
    await expect(fs.list("c1/")).rejects.toThrow(escapes);
    expect(await fs.list("")).toEqual([]);

    expect(await readdir(outside)).toEqual(["a.txt"]);
    expect(await Bun.file(join(outside, "a.txt")).text()).toBe("secret");
  });

  test("a symlinked file pointing outside root is rejected", async () => {
    const storage = join(root, "storage");
    await mkdir(join(storage, "c1"), { recursive: true });
    await writeFile(join(root, "secret.txt"), "secret");
    await symlink(join(root, "secret.txt"), join(storage, "c1/a.txt"));
    const fs = localFilesystem(storage);
    await expect(fs.file("c1/a.txt")).rejects.toThrow("escapes storage root");
    await expect(fs.delete("c1/a.txt")).rejects.toThrow("escapes storage root");
    expect(await Bun.file(join(root, "secret.txt")).text()).toBe("secret");
  });

  test("symlink inside root to another dir inside root works", async () => {
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "c1"));
    const fs = localFilesystem(root);
    await fs.write("c1/a.txt", new TextEncoder().encode("hi"));
    expect(await Bun.file(join(root, "real/a.txt")).text()).toBe("hi");
    expect(await (await fs.file("c1/a.txt"))?.blob.text()).toBe("hi");
    expect((await fs.list("c1/")).map((f) => f.key)).toEqual(["c1/a.txt"]);
    await fs.delete("c1/a.txt");
    expect(await fs.exists("c1/a.txt")).toBe(false);
  });

  test("delete removes the directories it leaves empty", async () => {
    const fs = localFilesystem(root);
    await fs.write("hbc_1/abc/a.txt", new Uint8Array([1]));
    await fs.write("hbc_1/abc/b.txt", new Uint8Array([1]));
    await fs.write("hbc_1/def/a.txt", new Uint8Array([1]));
    await fs.delete("hbc_1/abc/a.txt");
    expect(await readdir(join(root, "hbc_1/abc"))).toEqual(["b.txt"]);
    await fs.delete("hbc_1/abc/b.txt");
    expect(await readdir(join(root, "hbc_1"))).toEqual(["def"]);
    await fs.delete("hbc_1/def/a.txt");
    expect(await readdir(root)).toEqual([]);
  });

  test("a write whose source fails leaves no file and keeps the old one", async () => {
    const fs = localFilesystem(root);
    const broken = Bun.file(join(root, "missing-source"));
    await expect(fs.write("hbc_1/abc/a.txt", broken)).rejects.toThrow();
    expect(await fs.file("hbc_1/abc/a.txt")).toBeNull();

    await fs.write("hbc_1/abc/a.txt", new TextEncoder().encode("old"));
    await expect(fs.write("hbc_1/abc/a.txt", broken)).rejects.toThrow();
    expect(await (await fs.file("hbc_1/abc/a.txt"))?.blob.text()).toBe("old");
    expect(await readdir(join(root, "hbc_1/abc"))).toEqual(["a.txt"]);
  });

  test("a directory is not a file", async () => {
    const fs = localFilesystem(root);
    await fs.write("hbc_1/abc/a.txt", new Uint8Array([1]));
    expect(await fs.file("hbc_1/abc")).toBeNull();
  });

  test("deletePrefix removes whole path segments only", async () => {
    const fs = localFilesystem(root);
    const one = new Uint8Array([1]);
    await fs.write("hbc_1/abc/a.png", one);
    await fs.write("hbc_1/abc/thumbs_a.png/100x100_a.png", one);
    await fs.write("hbc_1/abc/b.png", one);
    await fs.write("hbc_1/def/a.png", one);
    await fs.write("hbc_10/abc/a.png", one);

    await fs.deletePrefix("hbc_1/abc/thumbs_a.png/");
    expect(await fs.file("hbc_1/abc/thumbs_a.png/100x100_a.png")).toBeNull();
    expect(await fs.file("hbc_1/abc/a.png")).not.toBeNull();

    await fs.deletePrefix("hbc_1/abc/a");
    expect(await readdir(join(root, "hbc_1/abc"))).toContain("a.png");

    await fs.deletePrefix("hbc_1");
    expect(await readdir(root)).toEqual(["hbc_10"]);
    expect(await fs.file("hbc_10/abc/a.png")).not.toBeNull();
    await fs.deletePrefix("hbc_missing/");
  });

  test("fileKey joins collection, record and filename", () => {
    expect(fileKey("hbc_1", "abc", "a.png")).toBe("hbc_1/abc/a.png");
  });

  test.each([
    "../x",
    "a/../../x",
    "/etc/passwd",
    "a\\..\\x",
    "a\0b",
    "",
    "a/./b",
  ])("rejects key %j", async (key) => {
    const fs = localFilesystem(root);
    const data = new Uint8Array([1]);
    await expect(fs.write(key, data)).rejects.toThrow();
    await expect(fs.file(key)).rejects.toThrow();
    await expect(fs.delete(key)).rejects.toThrow();
    await expect(fs.deletePrefix(key)).rejects.toThrow();
    await expect(fs.exists(key)).rejects.toThrow();
    if (key !== "") await expect(fs.list(key)).rejects.toThrow();
  });
});

describe("appFilesystem", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hb-fs-"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  test("watchers see deletes before they happen and writes", async () => {
    const fs = appFilesystem(() => localFilesystem(root));
    const seen: string[] = [];
    const stop = fs.watch({
      async deleting(key) {
        const found = key.endsWith("/")
          ? (await fs.list(key)).length > 0
          : await fs.exists(key);
        seen.push(`deleting ${key} ${found}`);
      },
      writing: (key) => seen.push(`writing ${key}`),
    });
    await fs.write("c/r/a.txt", new Uint8Array([1]));
    await fs.write("c/r/b.txt", new Uint8Array([1]));
    await fs.delete("c/r/a.txt");
    await fs.deletePrefix("c/");
    stop();
    await fs.write("c/r/c.txt", new Uint8Array([1]));
    await fs.delete("c/r/c.txt");
    expect(seen).toEqual([
      "writing c/r/a.txt",
      "writing c/r/b.txt",
      "deleting c/r/a.txt true",
      "deleting c/ true",
    ]);
  });

  test("delegates each call to the current filesystem", async () => {
    const other = await mkdtemp(join(tmpdir(), "hb-fs-"));
    try {
      let current = localFilesystem(root);
      const fs = appFilesystem(() => current);
      await fs.write("c/r/a.txt", new Uint8Array([1]));
      current = localFilesystem(other);
      expect(await fs.exists("c/r/a.txt")).toBe(false);
      await fs.write("c/r/b.txt", new Uint8Array([1]));
      expect(await readdir(join(other, "c/r"))).toEqual(["b.txt"]);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe("normalizeFilename", () => {
  test("snake cases the base and keeps the extension", () => {
    expect(normalizeFilename("My File (1).PNG")).toMatch(
      /^my_file_1_[a-z0-9]{10}\.PNG$/,
    );
    expect(normalizeFilename("HelloWorld2Go.txt")).toMatch(
      /^hello_world2_go_[a-z0-9]{10}\.txt$/,
    );
  });

  test("keeps double extensions", () => {
    expect(normalizeFilename("backup.a.tar.gz")).toMatch(
      /^backup_a_[a-z0-9]{10}\.tar\.gz$/,
    );
  });

  test("strips invalid extension characters", () => {
    expect(normalizeFilename("name.t xt!")).toMatch(/^name_[a-z0-9]{10}\.txt$/);
  });

  test("short or empty base names get an extra random part", () => {
    expect(normalizeFilename(".png")).toMatch(
      /^[a-z0-9]{10}_[a-z0-9]{10}\.png$/,
    );
    expect(normalizeFilename("ab.png")).toMatch(
      /^ab[a-z0-9]{10}_[a-z0-9]{10}\.png$/,
    );
    expect(normalizeFilename("")).toMatch(/^[a-z0-9]{10}_[a-z0-9]{10}$/);
  });

  test("a name without extension has none", () => {
    expect(normalizeFilename("README")).toMatch(/^readme_[a-z0-9]{10}$/);
  });

  test("a detected extension is used only when the name has none", () => {
    expect(normalizeFilename("README", ".txt")).toMatch(
      /^readme_[a-z0-9]{10}\.txt$/,
    );
    expect(normalizeFilename("image.", ".png")).toMatch(
      /^image_[a-z0-9]{10}\.png$/,
    );
    expect(normalizeFilename("a.pdf", ".png")).toMatch(/\.pdf$/);
  });

  test("long names are cut to 100 characters and extensions to 20", () => {
    const long = normalizeFilename(`${"a".repeat(250)}.${"b".repeat(30)}`);
    expect(long).toMatch(/^a{100}_[a-z0-9]{10}\.b{20}$/);
  });

  test("only the last 300 characters of the name are used", () => {
    expect(normalizeFilename(`${"a".repeat(400)}z.txt`)).toMatch(
      /^a{100}_[a-z0-9]{10}\.txt$/,
    );
  });

  test("non ascii characters act as separators", () => {
    expect(normalizeFilename("çay şeker.txt")).toMatch(
      /^ay_eker_[a-z0-9]{10}\.txt$/,
    );
  });

  test("two calls differ", () => {
    expect(normalizeFilename("a.txt")).not.toBe(normalizeFilename("a.txt"));
  });
});

describe("mimeExtension", () => {
  test.each([
    ["text/plain; charset=utf-8", ".txt"],
    ["image/png", ".png"],
    ["image/jpeg", ".jpg"],
    ["application/octet-stream", ""],
  ])("%s is %p", (mime, ext) => {
    expect(mimeExtension(mime)).toBe(ext);
  });
});

describe("sniffMime", () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  const fixture = (name: string) =>
    Bun.file(join(import.meta.dir, "fixtures", name)).bytes();

  test.each([
    ["a.png", "image/png"],
    ["a.jpg", "image/jpeg"],
    ["a.gif", "image/gif"],
    ["a.webp", "image/webp"],
    ["a.svg", "image/svg+xml"],
    ["a.pdf", "application/pdf"],
    ["a.txt", "text/plain; charset=utf-8"],
    ["a.json", "application/json"],
    ["a.zip", "application/zip"],
  ])("%s is %s", async (name, mime) => {
    const bytes = await fixture(name);
    expect(await sniffMime(bytes)).toBe(mime);
    expect(await sniffMime(new Blob([bytes]))).toBe(mime);
  });

  test("an svg with an xml prolog is svg", async () => {
    const bytes = await fixture("prolog.svg");
    expect(await sniffMime(bytes)).toBe("image/svg+xml");
  });

  test("an svg without the svg namespace is not svg", async () => {
    expect(await sniffMime(enc('<svg xmlns="x"></svg>'))).toBe(
      "text/plain; charset=utf-8",
    );
  });

  test.each([
    ["<!DOCTYPE html><title>x</title>", "text/html; charset=utf-8"],
    ["  \n<html>", "text/html; charset=utf-8"],
    ["<html\n<body>", "text/html; charset=utf-8"],
    ["<div\tclass=x>", "text/html; charset=utf-8"],
    ["<p\f>", "text/html; charset=utf-8"],
    ["<hTmL>", "text/html; charset=utf-8"],
    ["<script>1</script>", "text/html; charset=utf-8"],
    ["<!-- note -->", "text/html; charset=utf-8"],
    ["\ufeff<html>", "text/html; charset=utf-8"],
    ["<!--x--><p>", "text/plain; charset=utf-8"],
    ["<pre>", "text/plain; charset=utf-8"],
    ["<p", "text/plain; charset=utf-8"],
    ["<html", "text/plain; charset=utf-8"],
  ])("html detection of %p", async (text, mime) => {
    expect(await sniffMime(enc(text))).toBe(mime);
  });

  test.each([
    ['<html><meta charset="iso-8859-1">', "text/html; charset=iso-8859-1"],
    [
      '<html><meta http-equiv="Content-Type" content="text/html; charset=windows-1251">',
      "text/html; charset=windows-1251",
    ],
    [
      '<html><meta content="text/html; charset=windows-1251">',
      "text/html; charset=utf-8",
    ],
    ['<body><meta charset="iso-8859-1">', "text/html; charset=utf-8"],
    [
      '<html><!-- <meta charset="x"> --><meta charset="big5">',
      "text/html; charset=big5",
    ],
  ])("html charset of %p", async (text, mime) => {
    expect(await sniffMime(enc(text))).toBe(mime);
  });

  test.each([
    ['<?xml version="1.0"?><a/>', "text/xml; charset=utf-8"],
    ['\n<?xml version="1.0"?><a/>', "text/xml; charset=utf-8"],
    [
      '<?xml version="1.0" encoding="ISO-8859-1"?><a/>',
      "text/xml; charset=ISO-8859-1",
    ],
    [
      '<?xml version="1.0"?>\n<!DOCTYPE  html PUBLIC "x"><html>',
      "application/xhtml+xml",
    ],
    [
      '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml">',
      "application/xhtml+xml",
    ],
  ])("xml detection of %p", async (text, mime) => {
    expect(await sniffMime(enc(text))).toBe(mime);
  });

  test("binary without a known signature is octet-stream", async () => {
    expect(await sniffMime(new Uint8Array([0, 1, 2, 3]))).toBe(
      "application/octet-stream",
    );
    expect(await sniffMime(new Uint8Array(10000).fill(1))).toBe(
      "application/octet-stream",
    );
  });

  test("text charset follows the content", async () => {
    expect(await sniffMime(new Uint8Array([0xc3, 0x28]))).toBe(
      "text/plain; charset=iso-8859-1",
    );
    expect(await sniffMime(new Uint8Array([0xff, 0xfe, 0x00, 0x80]))).toBe(
      "text/plain; charset=utf-16le",
    );
  });

  test("text that is not json stays text", async () => {
    expect(await sniffMime(enc("{not json"))).toBe("text/plain; charset=utf-8");
  });

  test("only the first 4096 bytes are inspected", async () => {
    const items = Array.from({ length: 900 }, (_, i) => `{"k":${i}}`).join(",");
    const json = `[${items}]`;
    expect(await sniffMime(enc(json))).toBe("application/json");
    expect(await sniffMime(enc(`${json}x`))).toBe("application/json");
    expect(
      await sniffMime(enc(`${json.slice(0, 4000)}x${json.slice(4000)}`)),
    ).toBe("text/plain; charset=utf-8");
    expect(await sniffMime(enc(`[1,2,${"x".repeat(10)}`))).toBe(
      "text/plain; charset=utf-8",
    );

    const text = new Uint8Array(5000).fill(0x61);
    text[4999] = 0;
    expect(await sniffMime(new Blob([text]))).toBe("text/plain; charset=utf-8");
  });

  test("a multibyte character cut at the end of the head is still utf-8", async () => {
    const bytes = enc(`${"a".repeat(4095)}é zz`);
    expect(await sniffMime(bytes)).toBe("text/plain; charset=utf-8");
  });
});

describe("app.files", () => {
  test("a memory app keeps storage and data.db in a temp data dir removed on close", async () => {
    const app = testApp();
    expect(checkpointerOf(app.db)).toBeUndefined();
    await app.files.write("hbc_1/abc/a.txt", new Uint8Array([1]));
    expect(
      await Bun.file(join(app.dataDir, "storage/hbc_1/abc/a.txt")).exists(),
    ).toBe(true);
    expect(await Bun.file(join(app.dataDir, "data.db")).exists()).toBe(true);
    app.close();
    expect(await Bun.file(join(app.dataDir, "data.db")).exists()).toBe(false);
  });

  test("a disk app stores under <dir>/storage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hb-app-"));
    try {
      const app = createApp({ dir });
      expect(app.dataDir).toBe(dir);
      expect(checkpointerOf(app.db)).toBeDefined();
      await app.files.write("hbc_1/abc/a.txt", new Uint8Array([1]));
      expect(
        await Bun.file(join(dir, "storage/hbc_1/abc/a.txt")).exists(),
      ).toBe(true);
      app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sniffMime text decoding", () => {
  const png = Bun.file(join(import.meta.dir, "fixtures", "a.png")).bytes();

  test("does not decode text for a PNG", async () => {
    const decode = spyOn(TextDecoder.prototype, "decode");
    expect(await sniffMime(await png)).toBe("image/png");
    expect(decode).not.toHaveBeenCalled();
    decode.mockRestore();
  });

  test.each([
    [
      `<?xml version="1.0"?>\n<rss version="2.0"><channel/></rss>`,
      "application/rss+xml",
    ],
    [
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`,
      "application/atom+xml",
    ],
    [
      `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"/>`,
      "application/vnd.google-earth.kml+xml",
    ],
    [`<?xml version="1.0"?><feed></feed>`, "text/xml; charset=utf-8"],
  ])("xml subtype of %p is %p", async (text, type) => {
    expect(await sniffMime(new TextEncoder().encode(text))).toBe(type);
  });

  test("binary bytes containing <svg stay application/octet-stream", async () => {
    const bytes = new Uint8Array([0, 1, ...new TextEncoder().encode("<svg>")]);
    expect(await sniffMime(bytes)).toBe("application/octet-stream");
  });
});

describe("download sniffs once", () => {
  let app: ReturnType<typeof testApp>;

  beforeEach(() => {
    app = testApp();
  });
  afterEach(() => app.close());

  test.each(["", "?thumb=100x100"])("query %p", async (query) => {
    await app.collections.save({
      name: "docs",
      viewRule: "",
      fields: [
        {
          name: "doc",
          type: "file",
          maxSelect: 1,
          maxSize: 1000,
          thumbs: ["100x100"],
        },
      ],
    } as any);
    const r = await app.records("docs").create({
      doc: new File(["hello"], "a.txt"),
    });
    const sniff = spyOn(mime, "sniffMime");
    const url = new URL(`/api/files/docs/${r.id}/${r.doc}${query}`, "http://x");
    const found = createRouter().build().match("GET", url.pathname)!;
    const res = await found.run(
      createEvent(app, new Request(url), found.params),
    );
    expect(await res.text()).toBe("hello");
    expect(sniff).toHaveBeenCalledTimes(1);
    sniff.mockRestore();
  });
});

describe("download type cache", () => {
  let app: ReturnType<typeof testApp>;
  let url: URL;
  let path: string;

  beforeEach(async () => {
    app = testApp();
    const c = await app.collections.save({
      name: "docs",
      viewRule: "",
      fields: [{ name: "doc", type: "file", maxSelect: 1, maxSize: 1000 }],
    } as any);
    const r = await app.records("docs").create({
      doc: new File(["hello"], "a"),
    });
    url = new URL(`/api/files/docs/${r.id}/${r.doc}`, "http://x");
    path = join(app.dataDir, "storage", c.id, r.id as string, r.doc as string);
  });
  afterEach(() => app.close());

  const get = async () => {
    const found = createRouter().build().match("GET", url.pathname)!;
    const res = await found.run(
      createEvent(app, new Request(url), found.params),
    );
    await res.arrayBuffer();
    return res.headers.get("content-type");
  };

  test("a second download reuses the sniffed type", async () => {
    const sniff = spyOn(mime, "sniffMime");
    expect(await get()).toBe("text/plain; charset=utf-8");
    expect(await get()).toBe("text/plain; charset=utf-8");
    expect(sniff).toHaveBeenCalledTimes(1);
    sniff.mockRestore();
  });

  test("a new size or mtime sniffs again", async () => {
    await get();
    const sniff = spyOn(mime, "sniffMime");
    await writeFile(path, '{"a":1}');
    expect(await get()).toBe("application/json");
    expect(sniff).toHaveBeenCalledTimes(1);
    await writeFile(path, "%PDF-1.");
    await utimes(path, new Date(1_000_000), new Date(1_000_000));
    expect(await get()).toBe("application/pdf");
    expect(sniff).toHaveBeenCalledTimes(2);
    sniff.mockRestore();
  });
});

describe("download ServeContent", () => {
  let app: ReturnType<typeof testApp>;
  let id: string;
  let name: string;

  beforeEach(async () => {
    app = testApp();
    await app.collections.save({
      name: "docs",
      viewRule: "",
      fields: [
        {
          name: "doc",
          type: "file",
          maxSelect: 1,
          maxSize: 100000,
          thumbs: ["10x10"],
        },
      ],
    } as any);
  });
  afterEach(() => app.close());

  const upload = async (file: File) => {
    const r = await app.records("docs").create({ doc: file });
    id = r.id as string;
    name = r.doc as string;
  };

  const get = async (
    headers: Record<string, string>,
    init: RequestInit = {},
    query = "",
  ) => {
    const url = new URL(`/api/files/docs/${id}/${name}${query}`, "http://x");
    const found = createRouter().build().match("GET", url.pathname)!;
    return found.run(
      createEvent(app, new Request(url, { headers, ...init }), found.params),
    );
  };

  // statuses observed from PB v0.41.1 (contract/files.contract.ts compares the headers)
  const past = "Thu, 01 Jan 1970 00:00:01 GMT";
  const future = "Fri, 01 Jan 2100 00:00:00 GMT";
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
  ])("%p answers %d", async (headers, status) => {
    await upload(new File(["hello world!"], "a.txt"));
    const res = await get(headers);
    expect(res.status).toBe(status);
    if (status === 412) {
      expect(res.headers.get("last-modified")).toMatch(/ GMT$/);
      expect(await res.text()).toBe("");
    }
    if (status === 416) expect(await res.text()).toBe("invalid range\n");
  });

  test("bytes=0-1,4-5 returns 206 multipart/byteranges", async () => {
    await upload(new File(["hello world!"], "a.txt"));
    const res = await get({ range: "bytes=0-1,4-5" });
    expect(res.status).toBe(206);
    const type = res.headers.get("content-type")!;
    const boundary = type.replace("multipart/byteranges; boundary=", "");
    expect(boundary).toMatch(/^[0-9a-f]{60}$/);
    const body = await res.text();
    expect(res.headers.get("content-length")).toBe(String(body.length));
    const part = (range: string, data: string) =>
      `--${boundary}\r\nContent-Range: bytes ${range}/12\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${data}`;
    expect(body).toBe(
      `${part("0-1", "he")}\r\n${part("4-5", "o ")}\r\n--${boundary}--\r\n`,
    );
  });

  test("an aborted request does not start thumb generation", async () => {
    const png = await sharp({
      create: { width: 20, height: 20, channels: 3, background: "#f00" },
    })
      .png()
      .toBuffer();
    await upload(new File([png], "a.png"));
    const abort = new AbortController();
    abort.abort();
    const res = await get({}, { signal: abort.signal }, "?thumb=10x10");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array(png),
    );
    const c = app.collections.find("docs")!;
    expect(await app.files.list(`${c.id}/${id}/thumbs_`)).toEqual([]);
  });
});
