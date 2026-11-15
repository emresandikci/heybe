import { describe, expect, test } from "bun:test";
import { tokenize } from "./tokenizer";

const opts = { separators: "," };

describe("NUL like PB tools/tokenizer (its eof rune)", () => {
  test("ends the token it is in", () =>
    expect(tokenize("id\0x,title", opts)).toEqual(["id", "x", "title"]));

  test("at the start of a token ends the scan", () =>
    expect(tokenize("id,\0title,name", opts)).toEqual(["id"]));

  test("inside quotes leaves them unbalanced", () =>
    expect(() => tokenize("'a\0b'", opts)).toThrow(
      'unbalanced parenthesis or quoted expression: "\'a"',
    ));
});
