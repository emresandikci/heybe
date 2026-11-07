import { describe, expect, test } from "bun:test";
import { filterSyntaxError } from "./fexpr";

describe("filterSyntaxError", () => {
  test.each([
    ["foo = ", "invalid or incomplete filter expression"],
    ["a ==", 'invalid sign operator "=="'],
    ["(", "invalid formatted group - missing 1 closing bracket(s)"],
    ['"x', 'invalid quoted text "\\"x"'],
    ["a = 1 )", "unexpected character ')'"],
    [
      "= 1",
      'expected left operand (identifier, function, text or number), got "=" (sign)',
    ],
    [
      "a = 1 && || b = 2",
      'expected left operand (identifier, function, text or number), got "||" (join)',
    ],
    ["a = {x}", "unexpected character '{'"],
    ["a = 1 b = 2", 'expected && or ||, got "b" (identifier)'],
    ["a b", 'expected a sign operator, got "b" (identifier)'],
    ["a = ", "invalid or incomplete filter expression"],
    ["()", "empty filter expression"],
    ["a = 'x' \\n && a = 'y'", "unexpected character '\\\\'"],
    ["a = 1\r", "unexpected character '\\r'"],
    ["a = \x01", "unexpected character '\\x01'"],
    ["a = 1.", 'invalid number "1."'],
    ["a = b.", 'invalid identifier "b."'],
    ["f( = 1", "unsupported argument character '=' in function \"f\""],
    ["f(a", "invalid or incomplete function \"f\" (expected ')')"],
    ["f(a b) = 1", 'expected comma after the last argument in function "f"'],
  ])("%s", (input, message) => {
    expect(filterSyntaxError(input)).toBe(message);
  });

  test.each([
    "a = 1",
    "a = 'x' && (b ~ 'y' || c != null) // note",
    "f(a, 1, 'x') = 1",
    "f(a,) = 1",
    "@request.auth.id != ''",
  ])("accepts %s", (input) => {
    expect(filterSyntaxError(input)).toBeNull();
  });
});
