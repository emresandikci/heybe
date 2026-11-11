import { describe, expect, test } from "bun:test";
import { verifyPassword } from "./password";

const goStyle = async (plain: string) =>
  (
    await Bun.password.hash(new TextEncoder().encode(plain).subarray(0, 72), {
      algorithm: "bcrypt",
      cost: 4,
    })
  ).replace("$2b$", "$2a$");

const bunHash = (plain: string) =>
  Bun.password.hash(plain, { algorithm: "bcrypt", cost: 4 });

describe("verifyPassword", () => {
  test("a $2a$ hash verifies a password up to 72 bytes", async () => {
    const ascii = "correct horse battery";
    const unicode = "ğüşç".repeat(8) + "a".repeat(7);
    expect(new TextEncoder().encode(unicode).length).toBe(71);
    expect(await verifyPassword(ascii, await goStyle(ascii))).toBe(true);
    expect(await verifyPassword(unicode, await goStyle(unicode))).toBe(true);
  });

  test("a $2a$ hash compares only the first 72 bytes like Go", async () => {
    const head = "a".repeat(72);
    const hash = await goStyle(head);
    expect(await verifyPassword(head + "b".repeat(8), hash)).toBe(true);
    expect(
      await verifyPassword("a".repeat(69) + "x" + "aa" + "b".repeat(8), hash),
    ).toBe(false);
  });

  test("a $2b$ hash made by Bun for an 80-byte password still verifies, and its 72-byte prefix does not", async () => {
    const long = "a".repeat(72) + "b".repeat(8);
    const hash = await bunHash(long);
    expect(hash.startsWith("$2b$")).toBe(true);
    expect(await verifyPassword(long, hash)).toBe(true);
    expect(await verifyPassword("a".repeat(72), hash)).toBe(false);
  });

  test("a wrong password is rejected for both prefixes", async () => {
    const plain = "secret-pass";
    expect(await verifyPassword("nope", await goStyle(plain))).toBe(false);
    expect(await verifyPassword("nope", await bunHash(plain))).toBe(false);
  });
});
