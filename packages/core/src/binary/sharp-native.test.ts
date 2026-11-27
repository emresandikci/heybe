import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sharpNativeLoader } from "./sharp-native";

const ENTRY = "@img/sharp-p/lib/sharp-p.node";
const LIB = "@img/sharp-libvips-p/lib/libvips.dylib";

let dir: string;
let root: string;
let files: Map<string, string>;

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "hb-sharp-native-"));
  root = join(dir, "extract");
  files = new Map([
    [ENTRY, join(dir, "addon")],
    [LIB, join(dir, "lib")],
  ]);
  fs.writeFileSync(files.get(ENTRY)!, "addon-bytes");
  fs.writeFileSync(files.get(LIB)!, "libvips-bytes");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const extracted = () => fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"));

test("extracts the files keeping their layout and returns the entry path", () => {
  expect(sharpNativeLoader(files, ENTRY, "1.0.0", root)()).toBe(
    join(root, ENTRY),
  );
  expect(fs.readFileSync(join(root, ENTRY), "utf8")).toBe("addon-bytes");
  expect(fs.readFileSync(join(root, LIB), "utf8")).toBe("libvips-bytes");
  expect(extracted()).toEqual([]);
});

test("the default root is per user, version and platform under the temp dir", () => {
  const version = `test-${crypto.randomUUID()}`;
  const path = sharpNativeLoader(files, ENTRY, version)();
  const top = path.slice(0, path.indexOf("/@img/"));
  try {
    expect(top).toBe(
      join(
        tmpdir(),
        `hb-sharp-${process.getuid!()}`,
        `${version}-${process.platform}-${process.arch}`,
      ),
    );
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
});

test("refuses a parent dir other users can write or another user owns", () => {
  const load = sharpNativeLoader(files, ENTRY, "1.0.0", root);
  fs.chmodSync(dir, 0o777);
  expect(load).toThrow("must be a directory owned by the current user");
  fs.chmodSync(dir, 0o700);
  const uid = process.getuid!();
  const spy = spyOn(process, "getuid").mockReturnValue(uid + 1);
  try {
    expect(load).toThrow("must be a directory owned by the current user");
  } finally {
    spy.mockRestore();
  }
  expect(fs.existsSync(root)).toBe(false);
});

test("reuses an existing extraction without rewriting", () => {
  sharpNativeLoader(files, ENTRY, "1.0.0", root)();
  const past = new Date(2000, 0, 1);
  fs.utimesSync(join(root, LIB), past, past);
  sharpNativeLoader(files, ENTRY, "1.0.0", root)();
  expect(fs.statSync(join(root, LIB)).mtime).toEqual(past);
});

test("re-extracts when any file is missing or has the wrong size", () => {
  const load = sharpNativeLoader(files, ENTRY, "1.0.0", root);
  load();
  fs.rmSync(join(root, LIB));
  expect(load()).toBe(join(root, ENTRY));
  expect(fs.readFileSync(join(root, LIB), "utf8")).toBe("libvips-bytes");

  fs.rmSync(join(root, ENTRY));
  load();
  expect(fs.readFileSync(join(root, ENTRY), "utf8")).toBe("addon-bytes");

  fs.writeFileSync(join(root, ENTRY), "half");
  load();
  expect(fs.readFileSync(join(root, ENTRY), "utf8")).toBe("addon-bytes");
  expect(extracted()).toEqual([]);
});

test("two loaders racing on the same root both end with a complete dir", () => {
  const winner = sharpNativeLoader(files, ENTRY, "1.0.0", root);
  const loser = sharpNativeLoader(files, ENTRY, "1.0.0", root);
  const rename = fs.renameSync;
  // the winner extracts and renames while the loser is about to rename
  const spy = spyOn(fs, "renameSync").mockImplementationOnce((from, to) => {
    spy.mockImplementation(rename);
    winner();
    rename(from, to);
  });
  try {
    expect(loser()).toBe(join(root, ENTRY));
  } finally {
    spy.mockRestore();
  }
  expect(fs.readFileSync(join(root, ENTRY), "utf8")).toBe("addon-bytes");
  expect(fs.readFileSync(join(root, LIB), "utf8")).toBe("libvips-bytes");
  expect(extracted()).toEqual([]);
});

test("a loader keeps a complete dir another one renamed in while it extracted", () => {
  const winner = sharpNativeLoader(files, ENTRY, "1.0.0", root);
  const loser = sharpNativeLoader(files, ENTRY, "1.0.0", root);
  const write = fs.writeFileSync;
  let ino = 0;
  const spy = spyOn(fs, "writeFileSync").mockImplementationOnce((...args) => {
    spy.mockImplementation(write);
    winner();
    ino = fs.statSync(root).ino;
    write(...args);
  });
  try {
    loser();
  } finally {
    spy.mockRestore();
  }
  expect(fs.statSync(root).ino).toBe(ino);
  expect(fs.readFileSync(join(root, LIB), "utf8")).toBe("libvips-bytes");
  expect(extracted()).toEqual([]);
});
