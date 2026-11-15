import { describe, expect, test } from "bun:test";
import { Decimal, parseJson, readJson } from "./http";

describe("parseJson", () => {
  test("parses like JSON.parse for valid documents", () => {
    const text = '{"a":[1,-2500,"x\\u00e9\\n",true,false,null],"b":{}}';
    expect(parseJson(text)).toEqual(JSON.parse(text));
  });

  test("rejects duplicate names at any depth", () => {
    expect(() => parseJson('{"id":1,"id":2}')).toThrow("duplicate");
    expect(() => parseJson('{"a":[{"x":1,"x":1}]}')).toThrow("duplicate");
  });

  test("keeps integers above 2^53 exact", () => {
    expect(parseJson('{"id":9007199254740993}')).toEqual({
      id: 9007199254740993n,
    });
    expect(parseJson("[9007199254740991, 1.5]")).toEqual([
      9007199254740991,
      new Decimal(1.5),
    ]);
  });

  test("keeps the form of decimal and exponent numbers", () => {
    expect(parseJson("[1.0, 12345678901234567890e0, 2e1]")).toEqual([
      new Decimal(1),
      new Decimal(12345678901234567890),
      new Decimal(20),
    ]);
  });

  test("rejects invalid UTF-16 escapes and accepts pairs", () => {
    for (const bad of ['"\\ud800"', '"\\udc00x"', '"\\ud800\\u0041"'])
      expect(() => parseJson(bad)).toThrow("invalid surrogate");
    expect(parseJson('"\\ud83d\\ude00"')).toBe("\u{1f600}");
  });

  test("caps the nesting depth with a plain error", () => {
    const deep = (n: number) => "[".repeat(n) + "]".repeat(n);
    expect(parseJson(deep(10000))).toBeArray();
    expect(() => parseJson(deep(10001))).toThrow("max depth");
  });

  test("errors do not echo the document", () => {
    expect(() => parseJson('{"secret-key":1,"secret-key":2}')).toThrow(
      /^duplicate object member name at offset \d+$/,
    );
    expect(() => parseJson("secret")).toThrow(/^invalid JSON at offset 0$/);
  });

  test("parses a large string quickly", () => {
    const text = JSON.stringify("a\\".repeat(2_000_000));
    expect(parseJson(text)).toHaveLength(4_000_000);
  });

  test.each(["", "{", '{"a":1,}', "[1 2]", "01", '{"a":1} x', '"\n"', "nul"])(
    "rejects invalid text %p",
    (text) => {
      expect(() => parseJson(text)).toThrow(SyntaxError);
    },
  );
});

describe("readJson", () => {
  test("rejects invalid UTF-8", async () => {
    const res = new Response(
      new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]),
    );
    await expect(readJson(res, 1000)).rejects.toThrow();
  });
});
