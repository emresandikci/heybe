import { describe, expect, test } from "bun:test";
import { excerpt } from "./excerpt";
import { pickFields, pickItems } from "./serialize";

// expected values were read from the PocketBase v0.41.1 binary
const cases: [string, number, boolean, string][] = [
  ["<p>Hello <b>big</b> world</p>", 9, true, "Hello big..."],
  ["<title>T</title><div>a</div><div>b</div>", 100, false, "a b"],
  ["a&amp;b &lt;c&gt; &#65;&#x42; &nbsp;x", 100, false, "a&b <c> AB  x"],
  [
    "<script>var x=1</script>text<style>p{}</style>  more\n\n spaces",
    100,
    false,
    "text more spaces",
  ],
  [
    "<ul><li>one</li><li>two</li></ul><span>in</span>line",
    100,
    false,
    "one two inline",
  ],
  ["çok güzel bir gün çok güzel", 5, true, "çok g..."],
  ["<p>aaaa</p><p>bbbb</p><p>cccc</p>", 3, false, "aaa"],
  ["<p>aaaa</p>xx<p>bbbb</p>yy", 2, false, "aa"],
  [
    "<div>x<button>no</button>y</div><img src=a>z<br>w<hr>v",
    100,
    false,
    "xy zw v",
  ],
  ["no html at all, just text", 10, false, "no html at"],
  ["<!-- c --><p>vis</p><!doctype html>", 50, false, "vis"],
  ["a < b > c", 50, false, "a < b > c"],
  ["<textarea><b>t</b></textarea>after", 50, false, "after"],
];

describe("excerpt", () => {
  for (const [html, max, ellipsis, expected] of cases) {
    test(`${JSON.stringify(html)} (${max}, ${ellipsis})`, () => {
      expect(excerpt(html, max, ellipsis)).toBe(expected);
    });
  }
});

describe("excerpt on large or tricky input", () => {
  test("1 MB of raw-text tags", () => {
    const html = "<style></style>".repeat(70_000) + "<p>end</p>";
    expect(html.length).toBeGreaterThan(1_000_000);
    expect(excerpt(html, 10, false)).toBe("end");
  });

  test("1 MB of unclosed elements and unmatched end tags", () => {
    const html = "<div>a</span>".repeat(80_000);
    expect(excerpt(html, 5, true)).toBe("a a a...");
  });

  test("a character whose lower case is longer, before a raw-text tag", () => {
    expect(excerpt("İİİ<script>x</SCRIPT>after", 100, false)).toBe("İİİafter");
    expect(excerpt("İ<style>a</style><b>b</b>", 100, false)).toBe("İb");
  });
});

describe("pickFields modifiers", () => {
  const data = { id: "1", body: "<p>Hello <b>big</b> world</p>", n: 2 };

  test("applies excerpt to a picked field", () => {
    expect(pickFields(data, "body:excerpt(5,true)")).toEqual({
      body: "Hello...",
    });
  });

  test("star with a modifier applies it to every unlisted field", () => {
    expect(pickFields(data, "*:excerpt(1),id")).toEqual({
      id: "1",
      body: "H",
      n: 2,
    });
  });

  test("invalid modifiers are rejected even for an empty list", () => {
    for (const fields of [
      "body:excerpt(0)",
      "body:excerpt()",
      "body:excerpt(1,2,3)",
      "body:nope(1)",
      "body:excerpt(1",
    ])
      expect(() => pickItems([], fields)).toThrow();
  });
});
