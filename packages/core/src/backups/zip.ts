import { createReadStream, createWriteStream } from "node:fs";
import { type FileHandle, mkdir, open, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createDeflateRaw, createInflateRaw } from "node:zlib";

const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
const DEFLATE = 8;
const STORE = 0;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

export interface ZipWriter {
  addFile(localPath: string, name: string): Promise<void>;
  close(): Promise<void>;
}

interface Entry {
  name: string;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  modified: Date;
  mode: number;
}

function view(n: number) {
  const bytes = new Uint8Array(n);
  return { bytes, dv: new DataView(bytes.buffer) };
}

function concat(...parts: Uint8Array[]) {
  return Buffer.concat(parts);
}

function msdosTime(d: Date) {
  if (d.getUTCFullYear() < 1980) d = new Date(Date.UTC(1980, 0, 1));
  const date =
    d.getUTCDate() +
    ((d.getUTCMonth() + 1) << 5) +
    ((d.getUTCFullYear() - 1980) << 9);
  const time =
    (d.getUTCSeconds() >> 1) +
    (d.getUTCMinutes() << 5) +
    (d.getUTCHours() << 11);
  return { date: date & MAX16, time: time & MAX16 };
}

// Info-ZIP "extended timestamp" extra, like Go's writer.
function timeExtra(d: Date) {
  const { bytes, dv } = view(9);
  dv.setUint16(0, 0x5455, true);
  dv.setUint16(2, 5, true);
  dv.setUint8(4, 1);
  dv.setUint32(5, Math.floor(d.getTime() / 1000) >>> 0, true);
  return bytes;
}

// Go's detectUTF8: chars outside 0x20-0x7d and "\" need the UTF-8 flag.
function flags(name: string) {
  return /[^\x20-\x5b\x5d-\x7d]/.test(name) ? 0x0808 : 0x0008;
}

function localHeader(name: Uint8Array, nameFlags: number, modified: Date) {
  const extra = timeExtra(modified);
  const { date, time } = msdosTime(modified);
  const { bytes, dv } = view(30);
  dv.setUint32(0, 0x04034b50, true);
  dv.setUint16(4, 20, true);
  dv.setUint16(6, nameFlags, true);
  dv.setUint16(8, DEFLATE, true);
  dv.setUint16(10, time, true);
  dv.setUint16(12, date, true);
  dv.setUint16(26, name.length, true);
  dv.setUint16(28, extra.length, true);
  return concat(bytes, name, extra);
}

export function dataDescriptor(
  crc: number,
  compressed: number,
  size: number,
): Uint8Array {
  const zip64 = compressed >= MAX32 || size >= MAX32;
  const { bytes, dv } = view(zip64 ? 24 : 16);
  dv.setUint32(0, 0x08074b50, true);
  dv.setUint32(4, crc, true);
  if (zip64) {
    dv.setBigUint64(8, BigInt(compressed), true);
    dv.setBigUint64(16, BigInt(size), true);
  } else {
    dv.setUint32(8, compressed, true);
    dv.setUint32(12, size, true);
  }
  return bytes;
}

export function centralHeader(e: Entry): Uint8Array {
  const name = Buffer.from(e.name);
  const sizes64 = e.compressed >= MAX32 || e.size >= MAX32;
  const zip64 = sizes64 || e.offset >= MAX32;
  let extra = timeExtra(e.modified);
  if (zip64) {
    const z = view(28);
    z.dv.setUint16(0, 0x0001, true);
    z.dv.setUint16(2, 24, true);
    z.dv.setBigUint64(4, BigInt(e.size), true);
    z.dv.setBigUint64(12, BigInt(e.compressed), true);
    z.dv.setBigUint64(20, BigInt(e.offset), true);
    extra = concat(extra, z.bytes);
  }
  const { date, time } = msdosTime(e.modified);
  const { bytes, dv } = view(46);
  dv.setUint32(0, 0x02014b50, true);
  dv.setUint16(4, (3 << 8) | 20, true);
  dv.setUint16(6, sizes64 ? 45 : 20, true);
  dv.setUint16(8, flags(e.name), true);
  dv.setUint16(10, DEFLATE, true);
  dv.setUint16(12, time, true);
  dv.setUint16(14, date, true);
  dv.setUint32(16, e.crc, true);
  dv.setUint32(20, zip64 ? MAX32 : e.compressed, true);
  dv.setUint32(24, zip64 ? MAX32 : e.size, true);
  dv.setUint16(28, name.length, true);
  dv.setUint16(30, extra.length, true);
  dv.setUint32(
    38,
    (((e.mode << 16) >>> 0) | (e.mode & 0o200 ? 0 : 1)) >>> 0,
    true,
  );
  dv.setUint32(42, Math.min(e.offset, MAX32), true);
  return concat(bytes, name, extra);
}

export function directoryEnd(
  records: number,
  size: number,
  offset: number,
  end: number,
): Uint8Array {
  const parts: Uint8Array[] = [];
  if (records >= MAX16 || size >= MAX32 || offset >= MAX32) {
    const { bytes, dv } = view(56 + 20);
    dv.setUint32(0, 0x06064b50, true);
    dv.setBigUint64(4, 44n, true);
    dv.setUint16(12, 45, true);
    dv.setUint16(14, 45, true);
    dv.setBigUint64(24, BigInt(records), true);
    dv.setBigUint64(32, BigInt(records), true);
    dv.setBigUint64(40, BigInt(size), true);
    dv.setBigUint64(48, BigInt(offset), true);
    dv.setUint32(56, 0x07064b50, true);
    dv.setBigUint64(64, BigInt(end), true);
    dv.setUint32(72, 1, true);
    parts.push(bytes);
    records = MAX16;
    size = MAX32;
    offset = MAX32;
  }
  const { bytes, dv } = view(22);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, records, true);
  dv.setUint16(10, records, true);
  dv.setUint32(12, size, true);
  dv.setUint32(16, offset, true);
  parts.push(bytes);
  return concat(...parts);
}

function checksum(entry?: ZipEntry) {
  const sum = {
    crc: 0,
    size: 0,
    async *stage(source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        sum.crc = crc32(chunk, sum.crc);
        sum.size += chunk.length;
        if (entry && sum.size > entry.size)
          throw new Error(`checksum error for ${entry.name}`);
        yield chunk;
      }
    },
  };
  return sum;
}

export async function createZipWriter(path: string): Promise<ZipWriter> {
  const out = await open(path, "w");
  const entries: Entry[] = [];
  let written = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const write = async (bytes: Uint8Array) => {
    await out.write(bytes);
    written += bytes.length;
  };

  const serialized = <T>(fn: () => Promise<T>) => {
    const run = queue.then(() => {
      if (closed) throw new Error("zip writer is already closed");
      return fn();
    });
    queue = run.catch(() => {});
    return run;
  };

  return {
    addFile: (localPath, name) =>
      serialized(async () => {
        const info = await stat(localPath);
        if (info.isDirectory()) throw new Error("is a directory");
        const offset = written;
        const nameFlags = flags(name);
        await write(localHeader(Buffer.from(name), nameFlags, info.mtime));
        const sum = checksum();
        const start = written;
        await pipeline(
          createReadStream(localPath),
          sum.stage,
          createDeflateRaw({ level: 1 }),
          async (source: AsyncIterable<Buffer>) => {
            for await (const chunk of source) await write(chunk);
          },
        );
        const compressed = written - start;
        await write(dataDescriptor(sum.crc, compressed, sum.size));
        entries.push({
          name,
          crc: sum.crc,
          compressed,
          size: sum.size,
          offset,
          modified: info.mtime,
          mode: info.mode,
        });
      }),
    close: () =>
      (closing ??= serialized(async () => {
        closed = true;
        try {
          const start = written;
          for (const e of entries) await write(centralHeader(e));
          await write(
            directoryEnd(entries.length, written - start, start, written),
          );
        } finally {
          await out.close();
        }
      })),
  };
}

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  mode: number;
  isDir: boolean;
}

const invalid = () => new Error("not a valid zip file");

async function readAt(fh: FileHandle, position: number, length: number) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead !== length) throw invalid();
  return buf;
}

async function readDirectoryEnd(fh: FileHandle, fileSize: number) {
  const tailLength = Math.min(fileSize, 22 + MAX16);
  const tail = await readAt(fh, fileSize - tailLength, tailLength);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (
      tail.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + tail.readUInt16LE(i + 20) <= tail.length
    ) {
      at = i;
      break;
    }
  }
  if (at < 0) throw invalid();
  let records = tail.readUInt16LE(at + 10);
  let size = tail.readUInt32LE(at + 12);
  let offset = tail.readUInt32LE(at + 16);
  const endAt = fileSize - tailLength + at;
  if (
    (records === MAX16 || size === MAX32 || offset === MAX32) &&
    endAt >= 20
  ) {
    const locator = await readAt(fh, endAt - 20, 20);
    if (locator.readUInt32LE(0) === 0x07064b50) {
      const end64 = await readAt(fh, Number(locator.readBigUInt64LE(8)), 56);
      if (end64.readUInt32LE(0) !== 0x06064b50) throw invalid();
      records = Number(end64.readBigUInt64LE(32));
      size = Number(end64.readBigUInt64LE(40));
      offset = Number(end64.readBigUInt64LE(48));
    }
  }
  if (offset + size > fileSize) throw invalid();
  return { records, size, offset };
}

function entryMode(creator: number, external: number, name: string) {
  let mode = 0;
  if (creator === 3 || creator === 19) mode = external >>> 16;
  else if (creator === 0 || creator === 11 || creator === 14)
    mode =
      external & 0x10
        ? S_IFDIR | 0o777
        : S_IFREG | (external & 1 ? 0o444 : 0o666);
  const type = mode & S_IFMT;
  return {
    mode: mode & 0o7777,
    isDir: name.endsWith("/") || type === S_IFDIR,
    isFile: type === 0 || type === S_IFREG,
  };
}

function readEntries(dir: Buffer, records: number) {
  const entries: (ZipEntry & { isFile: boolean })[] = [];
  let at = 0;
  for (let i = 0; i < records; i++) {
    if (at + 46 > dir.length || dir.readUInt32LE(at) !== 0x02014b50)
      throw invalid();
    const nameLength = dir.readUInt16LE(at + 28);
    const extraLength = dir.readUInt16LE(at + 30);
    const commentLength = dir.readUInt16LE(at + 32);
    if (at + 46 + nameLength + extraLength + commentLength > dir.length)
      throw invalid();
    const name = dir.toString("utf8", at + 46, at + 46 + nameLength);
    let compressed = dir.readUInt32LE(at + 20);
    let size = dir.readUInt32LE(at + 24);
    let offset = dir.readUInt32LE(at + 42);
    const extra = dir.subarray(
      at + 46 + nameLength,
      at + 46 + nameLength + extraLength,
    );
    for (let x = 0; x + 4 <= extra.length;) {
      const id = extra.readUInt16LE(x);
      const length = extra.readUInt16LE(x + 2);
      let field = x + 4;
      x = field + length;
      if (id !== 0x0001 || x > extra.length) continue;
      const next = () => {
        if (field + 8 > x) throw invalid();
        field += 8;
        return Number(extra.readBigUInt64LE(field - 8));
      };
      if (size === MAX32) size = next();
      if (compressed === MAX32) compressed = next();
      if (offset === MAX32) offset = next();
    }
    entries.push({
      name,
      flags: dir.readUInt16LE(at + 8),
      method: dir.readUInt16LE(at + 10),
      crc: dir.readUInt32LE(at + 16),
      compressed,
      size,
      offset,
      ...entryMode(dir.readUInt8(at + 5), dir.readUInt32LE(at + 38), name),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function extractEntry(
  fh: FileHandle,
  src: string,
  e: ZipEntry,
  target: string,
) {
  const local = await readAt(fh, e.offset, 30);
  if (local.readUInt32LE(0) !== 0x04034b50) throw invalid();
  const start = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  await mkdir(dirname(target), { recursive: true });
  const sum = checksum(e);
  const data =
    e.compressed > 0
      ? createReadStream(src, { start, end: start + e.compressed - 1 })
      : Readable.from([]);
  await pipeline(
    data,
    e.method === DEFLATE ? createInflateRaw() : new PassThrough(),
    sum.stage,
    createWriteStream(target, { mode: e.mode }),
  );
  if (sum.crc !== e.crc || sum.size !== e.size)
    throw new Error(`checksum error for ${e.name}`);
}

// PB tools/archive/extract.go: only dirs and regular files are extracted.
export async function extractZip(
  src: string,
  dest: string,
  only?: string,
): Promise<void> {
  const fh = await open(src, "r");
  try {
    const { records, size, offset } = await readDirectoryEnd(
      fh,
      (await fh.stat()).size,
    );
    const entries = readEntries(await readAt(fh, offset, size), records);
    const base = resolve(dest) + sep;
    const targets = entries.map((e) => {
      const target = join(base, e.name);
      if (
        e.name.startsWith("/") ||
        e.name.includes("\0") ||
        !target.startsWith(base)
      )
        throw new Error(`invalid file path: ${target}`);
      if (e.flags & 1) throw new Error(`unsupported encrypted entry ${e.name}`);
      if (e.method !== STORE && e.method !== DEFLATE)
        throw new Error(
          `unsupported compression method ${e.method} for ${e.name}`,
        );
      return target;
    });
    for (const [i, e] of entries.entries()) {
      if (only !== undefined && e.name !== only) continue;
      if (e.isDir) await mkdir(targets[i]!, { recursive: true });
      else if (e.isFile) await extractEntry(fh, src, e, targets[i]!);
    }
  } finally {
    await fh.close();
  }
}
