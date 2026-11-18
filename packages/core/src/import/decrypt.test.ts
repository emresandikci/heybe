import { describe, expect, test } from "bun:test";
import { encryptLikePb } from "./pb-fixture";
import { decryptPbValue } from "./decrypt";

const KEY = "abcdefghijklmnopqrstuvwxyz012345";

describe("decryptPbValue", () => {
  test("decrypts a value encrypted like PB", () => {
    const text = '{"meta":{"appName":"Şirket"}}';
    expect(decryptPbValue(encryptLikePb(text, KEY), KEY)).toBe(text);
  });

  test("a wrong key throws", () => {
    const cipherText = encryptLikePb("secret", KEY);
    expect(() =>
      decryptPbValue(cipherText, "bcdefghijklmnopqrstuvwxyz0123456"),
    ).toThrow();
    expect(() => decryptPbValue(cipherText, "short")).toThrow();
  });
});
