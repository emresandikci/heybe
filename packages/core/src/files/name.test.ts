import { describe, expect, test } from "bun:test";
import { normalizeFilename } from "./name";

describe("normalizeFilename", () => {
  test("cuts the original name at 300 UTF-8 bytes like Go", () => {
    const name = `abc${"é".repeat(200)}.txt`;
    expect(normalizeFilename(name)).toMatch(/^[a-z0-9]{10}_[a-z0-9]{10}\.txt$/);
    expect(normalizeFilename(`abc${"é".repeat(140)}.txt`)).toMatch(
      /^abc_[a-z0-9]{10}\.txt$/,
    );
  });

  test("cuts the clean name at 100 bytes for a multi-byte name", () => {
    const name = `${"é".repeat(50)}${"a".repeat(150)}.txt`;
    expect(normalizeFilename(name)).toMatch(/^a{100}_[a-z0-9]{10}\.txt$/);
  });
});
