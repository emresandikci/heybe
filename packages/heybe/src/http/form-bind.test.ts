import { describe, expect, test } from "bun:test";
import { ApiError } from "./errors";
import {
  type FormField,
  FormBindError,
  bindForm,
  formValues,
} from "./form-bind";
import { emptyForm } from "./multipart";

const FIELDS: FormField[] = [
  ["listRule", "rule", "listRule"],
  ["n", "int", "n"],
  ["b", "bool", "b"],
  ["s3.bucket", "string", "s3.bucket", "backups.s3.bucket"],
  ["tags", "strings", "tags"],
  ["fields", "interface"],
];

const bind = (entries: [string, string][], current = {}) => {
  const values = new Map<string, string[]>();
  for (const [k, v] of entries) values.set(k, [...(values.get(k) ?? []), v]);
  return bindForm(values, FIELDS, current);
};

describe("bindForm", () => {
  test("ints parse like Go strconv.ParseInt with base 0", () => {
    const cases: [string, number][] = [
      ["0x19", 25],
      ["077", 63],
      ["0o17", 15],
      ["0b101", 5],
      ["1_000", 1000],
      ["+5", 5],
      ["-0x_1F", -31],
      ["", 0],
      ["9223372036854775807", 9223372036854775807],
    ];
    for (const [raw, n] of cases) expect(bind([["n", raw]]).n).toBe(n);
    for (const raw of [
      "1e3",
      "0.5",
      "1__0",
      "_1",
      "1_",
      "08",
      "0x",
      "9223372036854775808",
      "-",
    ])
      expect(() => bind([["n", raw]])).toThrow(FormBindError);
  });

  test("bools parse like Go strconv.ParseBool, empty is false", () => {
    expect(bind([["b", "T"]]).b).toBe(true);
    expect(bind([["b", ""]]).b).toBe(false);
    expect(() => bind([["b", "yes"]])).toThrow(FormBindError);
  });

  test("one key sets every path, lists keep all values, null rules become empty", () => {
    expect(
      bind([
        ["s3.bucket", "b"],
        ["tags", "a"],
        ["tags", "c"],
      ]),
    ).toEqual({
      listRule: "",
      s3: { bucket: "b" },
      backups: { s3: { bucket: "b" } },
      tags: ["a", "c"],
    });
    expect(bind([["x", "1"]], { listRule: "id != ''" })).toEqual({});
    expect(bindForm(new Map(), FIELDS, {})).toEqual({});
  });

  test("a value for a Go interface field is PB's 500", () => {
    let err: unknown;
    try {
      bind([["fields", "x"]]);
    } catch (e) {
      err = e;
    }
    expect((err as ApiError).status).toBe(500);
  });

  test("formValues puts the body values before the query values", () => {
    const form = emptyForm();
    form.values.set("a", ["body"]);
    const values = formValues(form, new URLSearchParams("a=query&b=q"));
    expect([...values]).toEqual([
      ["a", ["body", "query"]],
      ["b", ["q"]],
    ]);
    expect(form.values.get("a")).toEqual(["body"]);
  });
});
