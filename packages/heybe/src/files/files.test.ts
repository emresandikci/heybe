import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app";
import { sniffMime } from "./mime";
import { normalizeFilename } from "./name";
import { fileKey, localFilesystem } from "./storage";

describe("localFilesystem", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "heybe-fs-"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  test("write, read, delete round trip", async () => {
    const fs = localFilesystem(root);
    expect(await fs.file("pbc_1/abc/a.txt")).toBeNull();
    await fs.write("pbc_1/abc/a.txt", new TextEncoder().encode("hi"));
    expect(await (await fs.file("pbc_1/abc/a.txt"))?.text()).toBe("hi");
    await fs.write("pbc_1/abc/b.txt", new Blob(["yo"]));
    expect(await (await fs.file("pbc_1/abc/b.txt"))?.text()).toBe("yo");
    await fs.delete("pbc_1/abc/a.txt");
    expect(await fs.file("pbc_1/abc/a.txt")).toBeNull();
    await fs.delete("pbc_1/abc/missing.txt");
  });

  test("a directory is not a file", async () => {
    const fs = localFilesystem(root);
    await fs.write("pbc_1/abc/a.txt", new Uint8Array([1]));
    expect(await fs.file("pbc_1/abc")).toBeNull();
  });

  test("deletePrefix removes whole path segments only", async () => {
    const fs = localFilesystem(root);
    const one = new Uint8Array([1]);
    await fs.write("pbc_1/abc/a.png", one);
    await fs.write("pbc_1/abc/thumbs_a.png/100x100_a.png", one);
    await fs.write("pbc_1/abc/b.png", one);
    await fs.write("pbc_1/def/a.png", one);
    await fs.write("pbc_10/abc/a.png", one);

    await fs.deletePrefix("pbc_1/abc/thumbs_a.png/");
    expect(await fs.file("pbc_1/abc/thumbs_a.png/100x100_a.png")).toBeNull();
    expect(await fs.file("pbc_1/abc/a.png")).not.toBeNull();

    await fs.deletePrefix("pbc_1/abc/a");
    expect(await readdir(join(root, "pbc_1/abc"))).toContain("a.png");

    await fs.deletePrefix("pbc_1");
    expect(await readdir(root)).toEqual(["pbc_10"]);
    expect(await fs.file("pbc_10/abc/a.png")).not.toBeNull();
    await fs.deletePrefix("pbc_missing/");
  });

  test("fileKey joins collection, record and filename", () => {
    expect(fileKey("pbc_1", "abc", "a.png")).toBe("pbc_1/abc/a.png");
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
  test("a memory app gets a temp storage dir removed on close", async () => {
    const app = createApp({ dir: ":memory:" });
    await app.files.write("pbc_1/abc/a.txt", new Uint8Array([1]));
    expect(await app.files.file("pbc_1/abc/a.txt")).not.toBeNull();
    app.close();
  });

  test("a disk app stores under <dir>/storage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "heybe-app-"));
    try {
      const app = createApp({ dir });
      await app.files.write("pbc_1/abc/a.txt", new Uint8Array([1]));
      expect(
        await Bun.file(join(dir, "storage/pbc_1/abc/a.txt")).exists(),
      ).toBe(true);
      app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
