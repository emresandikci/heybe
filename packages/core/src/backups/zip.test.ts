import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  centralHeader,
  createZipWriter,
  dataDescriptor,
  directoryEnd,
  extractZip,
} from "./zip";

let dir: string;
let src: string;
let dest: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hb-zip-"));
  src = join(dir, "src");
  dest = join(dir, "dest");
  await mkdir(src);
});

afterEach(() => rm(dir, { recursive: true, force: true }));

async function put(name: string, data: string | Uint8Array) {
  await mkdir(dirname(join(src, name)), { recursive: true });
  await writeFile(join(src, name), data);
}

async function ourZip(names: Record<string, string>) {
  const path = join(dir, "our.zip");
  const zw = await createZipWriter(path);
  for (const [local, name] of Object.entries(names))
    await zw.addFile(join(src, local), name);
  await zw.close();
  return path;
}

async function cliZip(...args: string[]) {
  const path = join(dir, "cli.zip");
  const proc = Bun.spawn(["zip", "-q", ...args, path, "."], {
    cwd: src,
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0)
    throw new Error(await new Response(proc.stderr).text());
  return path;
}

async function expectSameFile(name: string) {
  expect(
    Buffer.compare(
      await readFile(join(dest, name)),
      await readFile(join(src, name)),
    ),
  ).toBe(0);
}

async function listing(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true }).catch(() => [])).sort();
}

const u16 = (b: Uint8Array, at: number) =>
  new DataView(b.buffer, b.byteOffset).getUint16(at, true);
const u32 = (b: Uint8Array, at: number) =>
  new DataView(b.buffer, b.byteOffset).getUint32(at, true);
const u64 = (b: Uint8Array, at: number) =>
  Number(new DataView(b.buffer, b.byteOffset).getBigUint64(at, true));

describe("zip", () => {
  test("round trip of nested files, an empty file and a 3 MB file", async () => {
    await put("a/b/c.txt", "nested");
    await put("empty", "");
    await put("big.bin", randomBytes(3 * 1024 * 1024));
    await put("ünï.txt", "utf8 name");
    await chmod(join(src, "a/b/c.txt"), 0o755);
    const zip = await ourZip({
      "a/b/c.txt": "a/b/c.txt",
      empty: "empty",
      "big.bin": "big.bin",
      "ünï.txt": "ünï.txt",
    });

    await extractZip(zip, dest);

    for (const name of ["a/b/c.txt", "empty", "big.bin", "ünï.txt"])
      await expectSameFile(name);
    expect((await stat(join(dest, "a/b/c.txt"))).mode & 0o777).toBe(0o755);
  });

  test("unzip -t accepts our zip", async () => {
    await put("x.txt", "x".repeat(10000));
    await put("empty", "");
    const zip = await ourZip({ "x.txt": "d/x.txt", empty: "empty" });

    const proc = Bun.spawn(["unzip", "-t", "-q", zip], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
  });

  test.each(["-r", "-r -0", "-r -fz"])(
    "reads zips made by zip %s",
    async (flags) => {
      await put("a/b/c.txt", "nested ".repeat(100));
      await put("top.txt", "top");
      await put("empty", "");
      const zip = await cliZip(...flags.split(" "));

      await extractZip(zip, dest);

      for (const name of ["a/b/c.txt", "top.txt", "empty"])
        await expectSameFile(name);
    },
  );

  test.each(["../evil", "/abs", "a/../../evil", "a\0b"])(
    "%s is rejected before any file is written",
    async (name) => {
      await put("ok.txt", "ok");
      await put("evil", "evil");
      const zip = await ourZip({ "ok.txt": "ok.txt", evil: name });

      await expect(extractZip(zip, dest)).rejects.toThrow(
        "invalid file path: ",
      );
      expect(await listing(dest)).toEqual([]);
      expect(await listing(dirname(dest))).not.toContain("evil");
    },
  );

  test("symlink entries (zip -y) are skipped", async () => {
    await put("a.txt", "a");
    await symlink("a.txt", join(src, "link"));
    const zip = await cliZip("-r", "-y");

    await extractZip(zip, dest);

    await expectSameFile("a.txt");
    await expect(lstat(join(dest, "link"))).rejects.toThrow();
  });

  test("a flipped data byte gives a checksum error", async () => {
    await put("a.txt", "hello world");
    const zip = await cliZip("-r", "-0");
    const bytes = await readFile(zip);
    bytes[bytes.indexOf("hello world")] ^= 1;
    await writeFile(zip, bytes);

    await expect(extractZip(zip, dest)).rejects.toThrow(
      "checksum error for a.txt",
    );
  });

  test("a truncated zip is rejected", async () => {
    await put("a.txt", "a".repeat(1000));
    const zip = await ourZip({ "a.txt": "a.txt" });
    const bytes = await readFile(zip);
    await writeFile(zip, bytes.subarray(0, bytes.length - 10));

    await expect(extractZip(zip, dest)).rejects.toThrow("not a valid zip file");
    expect(await listing(dest)).toEqual([]);
  });

  test("encrypted entries are rejected", async () => {
    await put("a.txt", "secret");
    const zip = await cliZip("-r", "-P", "x");

    await expect(extractZip(zip, dest)).rejects.toThrow(
      "unsupported encrypted entry a.txt",
    );
  });

  test("unsupported compression methods are rejected", async () => {
    await put("a.txt", "a");
    const zip = await cliZip("-r", "-0");
    const bytes = await readFile(zip);
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes[central + 10] = 12;
    await writeFile(zip, bytes);

    await expect(extractZip(zip, dest)).rejects.toThrow(
      "unsupported compression method 12 for a.txt",
    );
  });

  test("data beyond the declared size is never written", async () => {
    await put("a.txt", "a".repeat(5000));
    const zip = await ourZip({ "a.txt": "a.txt" });
    const bytes = await readFile(zip);
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(10, central + 24);
    await writeFile(zip, bytes);

    await expect(extractZip(zip, dest)).rejects.toThrow(
      "checksum error for a.txt",
    );
    const size = await stat(join(dest, "a.txt")).then(
      (s) => s.size,
      () => 0,
    );
    expect(size).toBeLessThanOrEqual(10);
  });

  test("reads a zip64 end of central directory through its locator", async () => {
    await put("a.txt", "zip64");
    const zip = await ourZip({ "a.txt": "a.txt" });
    const bytes = await readFile(zip);
    const end = bytes.length - 22;
    const z = Buffer.alloc(56 + 20 + 22);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeBigUInt64LE(1n, 24);
    z.writeBigUInt64LE(1n, 32);
    z.writeBigUInt64LE(BigInt(u32(bytes, end + 12)), 40);
    z.writeBigUInt64LE(BigInt(u32(bytes, end + 16)), 48);
    z.writeUInt32LE(0x07064b50, 56);
    z.writeBigUInt64LE(BigInt(end), 64);
    z.writeUInt32LE(1, 72);
    z.writeUInt32LE(0x06054b50, 76);
    z.writeUInt16LE(0xffff, 84);
    z.writeUInt16LE(0xffff, 86);
    z.writeUInt32LE(0xffffffff, 88);
    z.writeUInt32LE(0xffffffff, 92);
    await writeFile(zip, Buffer.concat([bytes.subarray(0, end), z]));

    await extractZip(zip, dest);

    await expectSameFile("a.txt");
  });

  test("dates before 1980 are stored as 1980-01-01", () => {
    const h = centralHeader({
      name: "a",
      crc: 0,
      compressed: 0,
      size: 0,
      offset: 0,
      modified: new Date(0),
      mode: 0o100644,
    });
    expect([u16(h, 12), u16(h, 14)]).toEqual([0, (1 << 5) | 1]);
  });

  test("parallel addFile calls produce a valid zip", async () => {
    const names = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);
    for (const name of names) await put(name, name.repeat(5000));
    const path = join(dir, "our.zip");
    const zw = await createZipWriter(path);

    await Promise.all(
      names.map((name) => zw.addFile(join(src, name), `p/${name}`)),
    );
    await zw.close();

    const proc = Bun.spawn(["unzip", "-t", "-q", path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    await extractZip(path, dest);
    for (const name of names)
      expect(await readFile(join(dest, "p", name), "utf8")).toBe(
        name.repeat(5000),
      );
  });

  test("addFile rejects a directory and a closed writer", async () => {
    const zw = await createZipWriter(join(dir, "our.zip"));
    await expect(zw.addFile(src, "src")).rejects.toThrow("is a directory");
    await zw.close();
    await put("a.txt", "a");
    await expect(zw.addFile(join(src, "a.txt"), "a.txt")).rejects.toThrow(
      "zip writer is already closed",
    );
  });

  test("centralHeader uses the zip64 extra for size 5e9 and offset 5e9", () => {
    const entry = {
      name: "a",
      crc: 7,
      compressed: 4e9,
      size: 5e9,
      offset: 5e9,
      modified: new Date(),
      mode: 0o100644,
    };
    const h = centralHeader(entry);

    expect(u16(h, 6)).toBe(45);
    expect([u32(h, 20), u32(h, 24), u32(h, 42)]).toEqual([
      0xffffffff, 0xffffffff, 0xffffffff,
    ]);
    expect(u32(h, 38)).toBe(0o100644 * 0x10000);
    const extra = h.subarray(46 + 1 + 9);
    expect([u16(extra, 0), u16(extra, 2)]).toEqual([1, 24]);
    expect([u64(extra, 4), u64(extra, 12), u64(extra, 20)]).toEqual([
      5e9, 4e9, 5e9,
    ]);

    const small = centralHeader({
      ...entry,
      compressed: 3,
      size: 5,
      offset: 9,
    });
    expect([
      u16(small, 6),
      u32(small, 20),
      u32(small, 24),
      u32(small, 42),
      u16(small, 30),
    ]).toEqual([20, 3, 5, 9, 9]);
  });

  test("dataDescriptor and directoryEnd switch to zip64 only when needed", () => {
    expect(dataDescriptor(1, 2, 3).length).toBe(16);
    const d = dataDescriptor(1, 2, 5e9);
    expect([d.length, u32(d, 0), u64(d, 8), u64(d, 16)]).toEqual([
      24, 0x08074b50, 2, 5e9,
    ]);

    expect(directoryEnd(2, 100, 1000, 1100).length).toBe(22);
    const end = directoryEnd(2, 100, 5e9, 5e9 + 100);
    expect(end.length).toBe(56 + 20 + 22);
    expect([u32(end, 0), u64(end, 32), u64(end, 40), u64(end, 48)]).toEqual([
      0x06064b50, 2, 100, 5e9,
    ]);
    expect([u32(end, 56), u64(end, 64)]).toEqual([0x07064b50, 5e9 + 100]);
    expect([u16(end, 86), u32(end, 88), u32(end, 92)]).toEqual([
      0xffff, 0xffffffff, 0xffffffff,
    ]);
  });
});
