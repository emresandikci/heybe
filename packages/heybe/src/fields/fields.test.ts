import { afterAll, describe, expect, test } from "bun:test";
import { tempDb } from "../test-db";
import type { Collection, Field, FieldType } from "../collections/model";
import { type FieldCtx, PasswordValue, fields } from "./index";
import { UploadedFile } from "./file";
import type { PrepareCtx } from "./shared";

const db = tempDb();
afterAll(() => db.close());
db.tx(() => db.run("CREATE TABLE targets (id TEXT PRIMARY KEY)"));
db.tx(() => db.run("INSERT INTO targets (id) VALUES ('a'), ('b'), ('c')"));
db.tx(() => db.run("CREATE TABLE posts (id TEXT PRIMARY KEY)"));
db.tx(() => db.run("INSERT INTO posts (id) VALUES ('Taken')"));

const targets = { id: "pbc_targets", name: "targets" } as Collection;
const posts = { id: "pbc_posts", name: "posts" } as Collection;

const ctx = (over: Partial<FieldCtx> = {}): FieldCtx => ({
  db,
  collection: posts,
  record: {},
  isNew: true,
  now: () => new Date("2026-01-01T00:00:00Z"),
  findCollection: (idOrName) =>
    idOrName === "pbc_targets" || idOrName === "targets" ? targets : null,
  ...over,
});

const field = (type: FieldType, opts: Record<string, unknown> = {}): Field =>
  ({
    id: "f",
    name: "test",
    type,
    system: false,
    hidden: false,
    presentable: false,
    ...opts,
  }) as Field;

const stored = (
  type: FieldType,
  opts: Record<string, unknown>,
  input: unknown,
) => fields[type].normalize(input, field(type, opts));

const check = (
  type: FieldType,
  opts: Record<string, unknown>,
  value: unknown,
  over?: Partial<FieldCtx>,
) => fields[type].validate(value, field(type, opts), ctx(over));

const code = (
  type: FieldType,
  opts: Record<string, unknown>,
  value: unknown,
  over?: Partial<FieldCtx>,
) => check(type, opts, value, over)?.code ?? null;

describe("sqlType", () => {
  test("comes from the ddl mapping", () => {
    expect(fields.number.sqlType).toBe("REAL");
    expect(fields.bool.sqlType).toBe("INTEGER");
    expect(fields.json.sqlType).toBe("TEXT");
    expect(fields.editor.sqlType).toBe("TEXT");
    expect(fields.relation.sqlType).toBe("TEXT");
  });
});

describe("text", () => {
  test.each<[unknown, string]>([
    ["", ""],
    ["test", "test"],
    [null, ""],
    [123, "123"],
    [true, "true"],
    [[1], ""],
  ])("normalize %p", (input, expected) => {
    expect(stored("text", {}, input)).toBe(expected);
  });

  test.each<[Record<string, unknown>, unknown, string | null]>([
    [{}, 123, "validation_unsupported_value_type"],
    [{}, "", null],
    [{ required: true }, "", "validation_required"],
    [{ required: true }, "abc", null],
    [{ min: 3 }, "ab", "validation_min_text_constraint"],
    [{ min: 3 }, "abc", null],
    [{ min: 3 }, "", null],
    [{ max: 3 }, "abcd", "validation_max_text_constraint"],
    [{ max: 3 }, "abc", null],
    [{}, "a".repeat(5001), "validation_max_text_constraint"],
    [{}, "a".repeat(5000), null],
    [{ max: 2 }, "çğ", null],
    [{ pattern: "^\\d+$" }, "abc", "validation_invalid_format"],
    [{ pattern: "^\\d+$" }, "123", null],
  ])("validate %p %p", (opts, value, expected) => {
    expect(code("text", opts, value)).toBe(expected);
  });

  test("messages", () => {
    expect(check("text", { required: true }, "")).toEqual({
      code: "validation_required",
      message: "Cannot be blank.",
    });
    expect(check("text", { min: 3 }, "ab")?.message).toBe(
      "Must be at least 3 character(s).",
    );
    expect(check("text", { max: 3 }, "abcd")?.message).toBe(
      "Must be no more than 3 character(s).",
    );
    expect(check("text", { pattern: "^a$" }, "b")?.message).toBe(
      "Invalid value format.",
    );
  });

  describe("primary key", () => {
    const pk = { primaryKey: true, required: true, pattern: "^[a-z0-9]+$" };
    const open = { primaryKey: true, required: true, pattern: "^[\\w-]+$" };

    test("required", () =>
      expect(code("text", pk, "")).toBe("validation_required"));
    test("format", () =>
      expect(code("text", pk, "ABC")).toBe("validation_invalid_format"));
    test("valid", () => expect(code("text", pk, "abc123")).toBeNull());
    test("pk change", () => {
      const over = { isNew: false, original: { id: "abc" } };
      expect(code("text", pk, "abd", over)).toBe("validation_pk_change");
      expect(code("text", pk, "abc", over)).toBeNull();
    });
    test("duplicate with custom pattern is case-insensitive", () => {
      expect(code("text", open, "taken")).toBe("validation_pk_invalid");
      expect(code("text", open, "free")).toBeNull();
    });
    test("forbidden character and reserved names with custom pattern", () => {
      expect(check("text", { ...open, pattern: ".*" }, "a b")).toEqual({
        code: "validation_forbidden_pk_character",
        message: "' ' is not a valid primary key character.",
        params: { ch: " " },
      });
      expect(code("text", { ...open, pattern: ".*" }, "nul")).toBe(
        "validation_reserved_pk",
      );
    });
  });
});

describe("number", () => {
  test.each<[unknown, number]>([
    ["", 0],
    ["test", 0],
    [false, 0],
    [true, 1],
    [-2, -2],
    [123.456, 123.456],
    ["12", 12],
    ["1.5", 1.5],
    [null, 0],
  ])("normalize %p", (input, expected) => {
    expect(stored("number", {}, input)).toBe(expected);
  });

  test.each<[Record<string, unknown>, unknown, string | null]>([
    [{}, "1", "validation_unsupported_value_type"],
    [{}, Number.NaN, "validation_not_a_number"],
    [{}, Number.POSITIVE_INFINITY, "validation_not_a_number"],
    [{}, 0, null],
    [{ required: true }, 0, "validation_required"],
    [{ required: true }, 1, null],
    [{ onlyInt: true }, 1.5, "validation_only_int_constraint"],
    [{ onlyInt: true }, 2, null],
    [{ min: 2 }, 1, "validation_min_number_constraint"],
    [{ min: 2 }, 2, null],
    [{ min: 2 }, 0, null],
    [{ max: 2 }, 3, "validation_max_number_constraint"],
    [{ max: 2 }, 2, null],
    [{ min: null, max: null }, 99, null],
  ])("validate %p %p", (opts, value, expected) => {
    expect(code("number", opts, value)).toBe(expected);
  });

  test("messages", () => {
    expect(check("number", { min: 2 }, 1)?.message).toBe(
      "Must be greater or equal than 2.",
    );
    expect(check("number", { max: 2.5 }, 3)?.message).toBe(
      "Must be less or equal than 2.5.",
    );
    expect(check("number", { onlyInt: true }, 1.5)?.message).toBe(
      "Decimal numbers are not allowed.",
    );
  });

  test("db round trip", () => {
    expect(fields.number.toDb(5)).toBe(5);
    expect(fields.number.fromDb(5, field("number"))).toBe(5);
    expect(fields.number.fromDb(null, field("number"))).toBe(0);
  });
});

describe("bool", () => {
  test.each<[unknown, boolean]>([
    ["", false],
    ["f", false],
    ["t", true],
    ["true", true],
    ["false", false],
    ["abc", false],
    [1, true],
    [0, false],
    [true, true],
    [null, false],
  ])("normalize %p", (input, expected) => {
    expect(stored("bool", {}, input)).toBe(expected);
  });

  test.each<[Record<string, unknown>, unknown, string | null]>([
    [{}, "true", "validation_unsupported_value_type"],
    [{}, false, null],
    [{ required: true }, false, "validation_required"],
    [{ required: true }, true, null],
  ])("validate %p %p", (opts, value, expected) => {
    expect(code("bool", opts, value)).toBe(expected);
  });

  test("db round trip", () => {
    expect(fields.bool.toDb(true)).toBe(1);
    expect(fields.bool.toDb(false)).toBe(0);
    expect(fields.bool.fromDb(1, field("bool"))).toBe(true);
    expect(fields.bool.fromDb(0, field("bool"))).toBe(false);
  });
});

describe("email", () => {
  test("normalize casts to string", () => {
    expect(stored("email", {}, 5)).toBe("5");
    expect(stored("email", {}, null)).toBe("");
  });

  test.each<[Record<string, unknown>, unknown, string | null]>([
    [{}, 123, "validation_unsupported_value_type"],
    [{}, "", null],
    [{ required: true }, "", "validation_required"],
    [{ required: true }, "test@example.com", null],
    [{}, "invalid", "validation_is_email"],
    [{}, "a@b", "validation_is_email"],
    [{}, "test+tag@sub.example.com", null],
    [
      { onlyDomains: ["example.org", "example.net"] },
      "test@example.com",
      "validation_email_domain_not_allowed",
    ],
    [{ onlyDomains: ["example.org", "example.com"] }, "test@example.com", null],
    [
      { exceptDomains: ["example.org", "example.com"] },
      "test@example.com",
      "validation_email_domain_not_allowed",
    ],
    [
      { exceptDomains: ["example.org", "example.net"] },
      "test@example.com",
      null,
    ],
  ])("validate %p %p", (opts, value, expected) => {
    expect(code("email", opts, value)).toBe(expected);
  });

  test("messages", () => {
    expect(check("email", {}, "invalid")?.message).toBe(
      "Must be a valid email address.",
    );
    expect(check("email", { onlyDomains: ["a.org"] }, "t@b.com")?.message).toBe(
      "Email domain is not allowed.",
    );
  });
});

describe("url", () => {
  test("normalize casts to string", () => {
    expect(stored("url", {}, "test")).toBe("test");
    expect(stored("url", {}, "")).toBe("");
  });

  test.each<[Record<string, unknown>, unknown, string | null]>([
    [{}, 123, "validation_unsupported_value_type"],
    [{}, "", null],
    [{ required: true }, "", "validation_required"],
    [{ required: true }, "https://example.com", null],
    [{}, "invalid", "validation_invalid_url"],
    [{}, "https://example.com/path?q=1#h", null],
    [{}, "http://localhost:8090", null],
    [
      { onlyDomains: ["example.org", "example.net"] },
      "https://example.com",
      "validation_url_domain_not_allowed",
    ],
    [
      { onlyDomains: ["example.org", "example.com"] },
      "https://example.com",
      null,
    ],
    [
      { exceptDomains: ["example.org", "example.com"] },
      "https://example.com",
      "validation_url_domain_not_allowed",
    ],
    [
      { exceptDomains: ["example.org", "example.net"] },
      "https://example.com",
      null,
    ],
  ])("validate %p %p", (opts, value, expected) => {
    expect(code("url", opts, value)).toBe(expected);
  });

  test("messages", () => {
    expect(check("url", {}, "invalid")?.message).toBe("Must be a valid url.");
    expect(
      check("url", { exceptDomains: ["example.com"] }, "https://example.com")
        ?.message,
    ).toBe("Url domain is not allowed.");
  });
});

describe("date", () => {
  test.each<[unknown, string]>([
    ["", ""],
    ["invalid", ""],
    [null, ""],
    ["2024-01-01 00:11:22.345Z", "2024-01-01 00:11:22.345Z"],
    [new Date("2024-01-02T03:04:05Z"), "2024-01-02 03:04:05.000Z"],
    ["2024-01-02T03:04:05Z", "2024-01-02 03:04:05.000Z"],
    ["2024-01-02T03:04:05+02:00", "2024-01-02 01:04:05.000Z"],
    ["2024-01-02", "2024-01-02 00:00:00.000Z"],
    ["2024-01-02 03:04:05", "2024-01-02 03:04:05.000Z"],
    [1704164645, "2024-01-02 03:04:05.000Z"],
  ])("normalize %p", (input, expected) => {
    expect(stored("date", {}, input)).toBe(expected);
  });

  test.each<[Record<string, unknown>, unknown, string | null]>([
    [{}, 123, "validation_unsupported_value_type"],
    [{}, "", null],
    [{ required: true }, "", "validation_required"],
    [{ required: true }, "2024-01-01 00:00:00.000Z", null],
    [
      { min: "2024-01-02 00:00:00.000Z" },
      "2024-01-01 00:00:00.000Z",
      "validation_min_greater_equal_than_required",
    ],
    [{ min: "2024-01-02 00:00:00.000Z" }, "2024-01-02 00:00:00.000Z", null],
    [
      { max: "2024-01-02 00:00:00.000Z" },
      "2024-01-03 00:00:00.000Z",
      "validation_max_less_equal_than_required",
    ],
    [{ max: "2024-01-02 00:00:00.000Z" }, "2024-01-02 00:00:00.000Z", null],
    [{ min: "2024-01-02 00:00:00.000Z" }, "", null],
    [{ min: "", max: "" }, "2024-01-03 00:00:00.000Z", null],
  ])("validate %p %p", (opts, value, expected) => {
    expect(code("date", opts, value)).toBe(expected);
  });

  test("messages", () => {
    expect(
      check(
        "date",
        { min: "2024-01-02 00:00:00.000Z" },
        "2024-01-01 00:00:00.000Z",
      )?.message,
    ).toBe("Must be no less than 2024-01-02 00:00:00 +0000 UTC.");
    expect(
      check(
        "date",
        { max: "2024-01-02 00:00:00.500Z" },
        "2024-01-03 00:00:00.000Z",
      )?.message,
    ).toBe("Must be no greater than 2024-01-02 00:00:00.5 +0000 UTC.");
  });

  test("db round trip", () => {
    expect(fields.date.toDb("2024-01-01 00:00:00.000Z")).toBe(
      "2024-01-01 00:00:00.000Z",
    );
    expect(fields.date.fromDb("", field("date"))).toBe("");
    expect(fields.date.fromDb(null, field("date"))).toBe("");
  });
});

describe("autodate", () => {
  test("normalize parses like date", () => {
    expect(stored("autodate", {}, "2024-01-01 00:11:22.345Z")).toBe(
      "2024-01-01 00:11:22.345Z",
    );
    expect(stored("autodate", {}, "invalid")).toBe("");
  });

  test("validate accepts anything", () => {
    expect(check("autodate", {}, "")).toBeNull();
    expect(check("autodate", {}, 123)).toBeNull();
  });
});

describe("select", () => {
  test.each<[unknown, unknown]>([
    [null, ""],
    ["", ""],
    [123, "123"],
    ["a", "a"],
    ['["a"]', "a"],
    [[], ""],
    [["a", "b"], "b"],
  ])("normalize single %p", (input, expected) => {
    expect(stored("select", {}, input)).toEqual(expected);
  });

  test.each<[unknown, unknown]>([
    [null, []],
    ["", []],
    [123, ["123"]],
    ["a", ["a"]],
    ['["a"]', ["a"]],
    [[], []],
    [
      ["a", "b", "c"],
      ["a", "b", "c"],
    ],
    [
      ["a", "b", "a", ""],
      ["a", "b"],
    ],
  ])("normalize multiple %p", (input, expected) => {
    expect(stored("select", { maxSelect: 2 }, input)).toEqual(expected);
  });

  const values = ["a", "b", "c"];
  test.each<[Record<string, unknown>, unknown, string | null]>([
    [{ values }, "", null],
    [{ values, required: true }, "", "validation_required"],
    [{ values, required: true }, [], "validation_required"],
    [{ values }, "a", null],
    [{ values }, "d", "validation_invalid_value"],
    [{ values, maxSelect: 2 }, ["a", "b"], null],
    [{ values, maxSelect: 2 }, ["a", "b", "c"], "validation_too_many_values"],
    [{ values, maxSelect: 2 }, ["a", "d"], "validation_invalid_value"],
    [{ values }, ["a", "b"], "validation_too_many_values"],
  ])("validate %p %p", (opts, value, expected) => {
    expect(code("select", opts, value)).toBe(expected);
  });

  test("messages", () => {
    expect(check("select", { values }, "d")?.message).toBe("Invalid value d.");
    expect(
      check("select", { values, maxSelect: 2 }, ["a", "b", "c"])?.message,
    ).toBe("Select no more than 2.");
  });

  test("db round trip", () => {
    const multi = field("select", { maxSelect: 2 });
    expect(fields.select.toDb(["a", "b"])).toBe('["a","b"]');
    expect(fields.select.toDb("a")).toBe("a");
    expect(fields.select.fromDb('["a","b"]', multi)).toEqual(["a", "b"]);
    expect(fields.select.fromDb("", multi)).toEqual([]);
    expect(fields.select.fromDb(null, multi)).toEqual([]);
    expect(fields.select.fromDb("a", field("select"))).toBe("a");
    expect(fields.select.fromDb(null, field("select"))).toBe("");
  });
});

describe("json", () => {
  test.each<[unknown, unknown]>([
    ["null", null],
    ["", ""],
    ["true", true],
    ["false", false],
    ["test", "test"],
    ["123", 123],
    ["-456", -456],
    ["[1,2,3]", [1, 2, 3]],
    ["[1,2,3", "[1,2,3"],
    ['{"a":1,"b":2}', { a: 1, b: 2 }],
    ['{"a":1,"b":2', '{"a":1,"b":2'],
    [
      [1, 2, 3],
      [1, 2, 3],
    ],
    [
      { a: 1, b: 2 },
      { a: 1, b: 2 },
    ],
    [null, null],
    [undefined, null],
    [false, false],
    [true, true],
    [-78, -78],
    [123.456, 123.456],
  ])("normalize %p", (input, expected) => {
    expect(stored("json", {}, input)).toEqual(expected);
  });

  test.each<[Record<string, unknown>, unknown, string | null]>([
    [{}, null, null],
    [{ required: true }, null, "validation_required"],
    [{ required: true }, "", "validation_required"],
    [{ required: true }, [], "validation_required"],
    [{ required: true }, {}, "validation_required"],
    [{ required: true }, [1, 2, 3], null],
    [{ required: true }, "aaa", null],
    [{ maxSize: 5 }, "aaaa", "validation_json_size_limit"],
    [{ maxSize: 6 }, "aaaa", null],
    [{}, "a".repeat(1 << 20), "validation_json_size_limit"],
    [{}, { a: 1 }, null],
  ])("validate %p %p", (opts, value, expected) => {
    expect(code("json", opts, value)).toBe(expected);
  });

  test("messages", () => {
    expect(check("json", { maxSize: 5 }, "aaaa")?.message).toBe(
      "The maximum allowed JSON size is 5 bytes.",
    );
  });

  test("db round trip", () => {
    expect(fields.json.toDb(null)).toBeNull();
    expect(fields.json.toDb({ a: 1 })).toBe('{"a":1}');
    expect(fields.json.toDb("x")).toBe('"x"');
    expect(fields.json.fromDb(null, field("json"))).toBeNull();
    expect(fields.json.fromDb("", field("json"))).toBe("");
    expect(fields.json.fromDb("hi", field("json"))).toBe("hi");
    expect(fields.json.fromDb(2.5, field("json"))).toBe(2.5);
    expect(fields.json.fromDb('{"a":1}', field("json"))).toEqual({ a: 1 });
    expect(fields.json.fromDb("[1]", field("json"))).toEqual([1]);
  });
});

describe("relation", () => {
  const rel = { collectionId: "pbc_targets" };

  test.each<[Record<string, unknown>, unknown, unknown]>([
    [{}, null, ""],
    [{}, "a", "a"],
    [{}, ["a", "b"], "b"],
    [{}, '["a"]', "a"],
    [{ maxSelect: 2 }, null, []],
    [{ maxSelect: 2 }, "a", ["a"]],
    [{ maxSelect: 2 }, ["a", "b", "a"], ["a", "b"]],
  ])("normalize %p %p", (opts, input, expected) => {
    expect(stored("relation", opts, input)).toEqual(expected);
  });

  test.each<[Record<string, unknown>, unknown, string | null]>([
    [rel, "", null],
    [{ ...rel, required: true }, "", "validation_required"],
    [{ ...rel, required: true }, [], "validation_required"],
    [rel, "a", null],
    [rel, "missing", "validation_missing_rel_records"],
    [{ ...rel, maxSelect: 3 }, ["a", "b"], null],
    [
      { ...rel, maxSelect: 3 },
      ["a", "missing"],
      "validation_missing_rel_records",
    ],
    [{ ...rel, maxSelect: 2 }, ["a", "b", "c"], "validation_too_many_values"],
    [
      { ...rel, maxSelect: 3, minSelect: 2 },
      ["a"],
      "validation_not_enough_values",
    ],
    [{ collectionId: "pbc_nope" }, "a", "validation_missing_rel_collection"],
    [{ collectionId: "targets" }, "a", null],
  ])("validate %p %p", (opts, value, expected) => {
    expect(code("relation", opts, value)).toBe(expected);
  });

  test("messages", () => {
    expect(
      check("relation", { ...rel, maxSelect: 3, minSelect: 2 }, ["a"])?.message,
    ).toBe("Select at least 2.");
    expect(check("relation", rel, "missing")?.message).toBe(
      "Failed to find all relation records with the provided ids.",
    );
    expect(check("relation", { collectionId: "x" }, "a")?.message).toBe(
      "Relation connection is missing or cannot be accessed.",
    );
  });

  test("db round trip", () => {
    const multi = field("relation", { maxSelect: 2 });
    expect(fields.relation.toDb(["a", "b"])).toBe('["a","b"]');
    expect(fields.relation.toDb("a")).toBe("a");
    expect(fields.relation.fromDb('["a","b"]', multi)).toEqual(["a", "b"]);
    expect(fields.relation.fromDb("", multi)).toEqual([]);
    expect(fields.relation.fromDb("a", field("relation"))).toBe("a");
  });
});

describe("file", () => {
  test.each<[Record<string, unknown>, unknown, unknown]>([
    [{ maxSelect: 1 }, null, ""],
    [{ maxSelect: 1 }, "", ""],
    [{ maxSelect: 1 }, 123, "123"],
    [{ maxSelect: 1 }, "a", "a"],
    [{ maxSelect: 1 }, '["a"]', "a"],
    [{ maxSelect: 1 }, [], ""],
    [{ maxSelect: 1 }, ["a", "b"], "b"],
    [{ maxSelect: 2 }, null, []],
    [{ maxSelect: 2 }, "", []],
    [{ maxSelect: 2 }, 123, ["123"]],
    [{ maxSelect: 2 }, "a", ["a"]],
    [{ maxSelect: 2 }, '["a"]', ["a"]],
    [{ maxSelect: 2 }, [], []],
    [{ maxSelect: 2 }, ["a", "b", "c"], ["a", "b", "c"]],
    [{ maxSelect: 2 }, ["a", "a", "b"], ["a", "b"]],
  ])("normalize %p %p", (opts, input, expected) => {
    expect(stored("file", opts, input)).toEqual(expected);
  });

  const original = { test: ["a.txt", "b.txt"] };
  test.each<[Record<string, unknown>, unknown, string | null]>([
    [{ maxSelect: 2 }, [], null],
    [{ maxSelect: 2, required: true }, [], "validation_required"],
    [{ maxSelect: 1, required: true }, "", "validation_required"],
    [{ maxSelect: 2 }, ["a.txt"], null],
    [{ maxSelect: 2 }, ["a.txt", "new.txt"], "validation_invalid_file"],
    [{ maxSelect: 1 }, "new.txt", "validation_invalid_file"],
    [{ maxSelect: 1 }, "a.txt", null],
  ])("validate %p %p", (opts, value, expected) => {
    expect(code("file", opts, value, { isNew: false, original })).toBe(
      expected,
    );
  });

  test("new record has no existing files", () => {
    expect(code("file", { maxSelect: 2 }, ["a.txt"])).toBe(
      "validation_invalid_file",
    );
  });

  test("too many files", () => {
    const orig = { test: ["a", "b", "c"] };
    expect(
      code("file", { maxSelect: 2 }, ["a", "b", "c"], {
        isNew: false,
        original: orig,
      }),
    ).toBe("validation_too_many_files");
    expect(
      code("file", {}, ["a", "b"], {
        isNew: false,
        original: { test: ["a", "b"] },
      }),
    ).toBe("validation_too_many_files");
  });

  test("messages", () => {
    expect(check("file", { maxSelect: 2 }, ["x.txt", "y.txt"])?.message).toBe(
      "Invalid new files: [x.txt y.txt].",
    );
    expect(
      check("file", { maxSelect: 2 }, ["a", "b", "c"], {
        isNew: false,
        original: { test: ["a", "b", "c"] },
      })?.message,
    ).toBe("The maximum allowed files is 2.");
  });

  test("db round trip", () => {
    const multi = field("file", { maxSelect: 2 });
    expect(fields.file.toDb(["a", "b"])).toBe('["a","b"]');
    expect(fields.file.toDb("a")).toBe("a");
    expect(fields.file.fromDb('["a"]', multi)).toEqual(["a"]);
    expect(fields.file.fromDb("", multi)).toEqual([]);
    expect(fields.file.fromDb("", field("file", { maxSelect: 1 }))).toBe("");
  });

  const upload = (
    name: string,
    size = 10,
    type = "text/plain; charset=utf-8",
  ) => new UploadedFile(name, `original ${name}`, size, type);

  test("normalize keeps uploads next to names", () => {
    const file = new File(["x"], "x.txt");
    const up = upload("u.txt");
    expect(stored("file", { maxSelect: 3 }, ["a", file, up, "a"])).toEqual([
      "a",
      file,
      up,
    ]);
    expect(stored("file", { maxSelect: 1 }, ["a", up])).toBe(up);
    expect(stored("file", { maxSelect: 1 }, file)).toBe(file);
  });

  test("a File that skipped prepare is rejected", () => {
    expect(code("file", { maxSelect: 2 }, [new File(["x"], "x.txt")])).toBe(
      "validation_unsupported_value_type",
    );
  });

  test("prepare uploads Files nested in arrays", async () => {
    const ctx: PrepareCtx = {
      collection: { id: "pbc_1" } as Collection,
      recordId: "rec1",
      files: { write: async () => {} } as unknown as PrepareCtx["files"],
      written: [],
    };
    const value = (await fields.file.prepare!(
      [[new File(["x"], "nested.txt")]],
      field("file", { maxSelect: 2 }),
      ctx,
    )) as unknown[][];
    expect(value[0]![0]).toBeInstanceOf(UploadedFile);
    expect(ctx.written).toHaveLength(1);
  });

  test("uploads are not invalid new files", () => {
    expect(code("file", { maxSelect: 2 }, [upload("u.txt")])).toBeNull();
  });

  test("an upload over maxSize", () => {
    expect(check("file", { maxSize: 5 }, upload("u.txt", 6))).toEqual({
      code: "validation_file_size_limit",
      message:
        "Failed to upload original u.txt - the maximum allowed file size is 5 bytes.",
      params: { file: "original u.txt", maxSize: 5 },
    });
    expect(code("file", {}, upload("u.txt", 5 << 20))).toBeNull();
    expect(code("file", {}, upload("u.txt", (5 << 20) + 1))).toBe(
      "validation_file_size_limit",
    );
  });

  test("an upload with a mime type outside mimeTypes", () => {
    const opts = { mimeTypes: ["image/png", "text/plain"] };
    expect(code("file", opts, upload("u.txt"))).toBeNull();
    expect(check("file", opts, upload("u.png", 10, "application/pdf"))).toEqual(
      {
        code: "validation_invalid_mime_type",
        message: '"u.png" mime type must be one of: image/png, text/plain.',
      },
    );
  });

  test("toDb stores upload names", () => {
    expect(fields.file.toDb(["a", upload("u.txt")])).toBe('["a","u.txt"]');
    expect(fields.file.toDb(upload("u.txt"))).toBe("u.txt");
  });

  test("prepare writes new files under the record and returns uploads", async () => {
    const writes: string[] = [];
    const ctx: PrepareCtx = {
      collection: { id: "pbc_1" } as Collection,
      recordId: "rec1",
      files: {
        write: async (key: string) => void writes.push(key),
      } as unknown as PrepareCtx["files"],
      written: [],
    };
    const png = Bun.file(new URL("../files/fixtures/a.png", import.meta.url));
    const value = (await fields.file.prepare!(
      [
        "kept.txt",
        new File([await png.bytes()], "image"),
        new File(["hi"], "Hello World.txt"),
      ],
      field("file", { maxSelect: 3 }),
      ctx,
    )) as unknown[];
    expect(value[0]).toBe("kept.txt");
    const [image, text] = value.slice(1) as UploadedFile[];
    expect(image).toBeInstanceOf(UploadedFile);
    expect(image!.name).toMatch(/^image_[a-z0-9]{10}\.png$/);
    expect(image!.type).toBe("image/png");
    expect(text!.name).toMatch(/^hello_world_[a-z0-9]{10}\.txt$/);
    expect(text!.originalName).toBe("Hello World.txt");
    expect(text!.size).toBe(2);
    const keys = [image!.name, text!.name].map((n) => `pbc_1/rec1/${n}`);
    expect(writes).toEqual(keys);
    expect(ctx.written).toEqual(keys);
  });
});

describe("password", () => {
  const cheap = { cost: 4 };
  const pw = field("password", cheap);
  const prepared = async (opts: Record<string, unknown>, input: unknown) => {
    const f = field("password", { ...cheap, ...opts });
    return (await fields.password.prepare!(
      input,
      f,
      {} as PrepareCtx,
    )) as PasswordValue;
  };

  test("normalize keeps plain and does not hash", () => {
    const v = fields.password.normalize("secret123", pw) as PasswordValue;
    expect(v).toBeInstanceOf(PasswordValue);
    expect(v.plain).toBe("secret123");
    expect(v.hash).toBe("");
  });

  test("normalize of empty or non-string input gives the zero value", () => {
    for (const input of ["", null, undefined, [1], {}]) {
      const v = fields.password.normalize(input, pw) as PasswordValue;
      expect(v.hash).toBe("");
      expect(v.plain).toBe("");
    }
  });

  test("normalize never passes a JSON-shaped value through", () => {
    const v = fields.password.normalize(
      { hash: "x", plain: "" },
      pw,
    ) as PasswordValue;
    expect(v).toBeInstanceOf(PasswordValue);
    expect(v.hash).toBe("");
    expect(fields.password.toDb(v)).not.toBe("x");
    expect(fields.password.toDb({ hash: "x", plain: "" })).toBe("");
  });

  test("normalize keeps an existing instance", () => {
    const v = new PasswordValue("h");
    expect(fields.password.normalize(v, pw)).toBe(v);
  });

  test("prepare hashes plain with bcrypt and keeps it for validation", async () => {
    const v = await prepared({}, "secret123");
    expect(v.plain).toBe("secret123");
    expect(v.hash).toMatch(/^\$2[ab]\$04\$/);
    expect(await Bun.password.verify("secret123", v.hash)).toBe(true);
    expect(fields.password.toDb(v)).toBe(v.hash);
  });

  test("prepare default cost is 10", async () => {
    const f = field("password");
    const v = (await fields.password.prepare!(
      "secret123",
      f,
      {} as PrepareCtx,
    )) as PasswordValue;
    expect(v.hash).toMatch(/^\$2[ab]\$10\$/);
  });

  test("prepare leaves empty and loaded values alone", async () => {
    const empty = fields.password.normalize("", pw);
    const ctx = {} as PrepareCtx;
    expect(await fields.password.prepare!(empty, pw, ctx)).toBe(empty);
    const loaded = fields.password.fromDb("$2b$04$abc", pw);
    expect(await fields.password.prepare!(loaded, pw, ctx)).toBe(loaded);
  });

  const plain = (opts: Record<string, unknown>, input: string) =>
    code(
      "password",
      { ...cheap, ...opts },
      fields.password.normalize(input, field("password", opts)),
    );

  test.each<[Record<string, unknown>, string, string | null]>([
    [{}, "", null],
    [{ required: true }, "", "validation_required"],
    [{ required: true }, "abcdefgh", null],
    [{ min: 5 }, "abc", "validation_min_text_constraint"],
    [{ min: 5 }, "abcde", null],
    [{ max: 5 }, "abcdef", "validation_max_text_constraint"],
    [{ max: 5 }, "abcde", null],
    [{}, "a".repeat(72), "validation_max_text_constraint"],
    [{}, "a".repeat(71), null],
    [{ pattern: "^\\d+$" }, "abc", "validation_invalid_format"],
    [{ pattern: "^\\d+$" }, "123", null],
  ])("validate %p %p", (opts, input, expected) => {
    expect(plain(opts, input)).toBe(expected);
  });

  test("a plain object is an unsupported value", () => {
    expect(code("password", {}, "abc")).toBe(
      "validation_unsupported_value_type",
    );
    expect(code("password", {}, { hash: "x", plain: "" })).toBe(
      "validation_unsupported_value_type",
    );
  });

  test("a stored hash alone is not re-validated but satisfies required", () => {
    const loaded = fields.password.fromDb("$2b$04$abc", pw);
    expect(code("password", { required: true, min: 50 }, loaded)).toBeNull();
    expect(code("password", { required: true }, new PasswordValue())).toBe(
      "validation_required",
    );
  });

  test("messages", () => {
    const v = (opts: Record<string, unknown>, input: string) =>
      fields.password.normalize(input, field("password", opts));
    expect(check("password", { min: 5 }, v({}, "abc"))?.message).toBe(
      "Must be at least 5 character(s).",
    );
    expect(check("password", { max: 5 }, v({}, "abcdef"))?.message).toBe(
      "Must be less than 5 character(s).",
    );
    expect(check("password", { pattern: "^a$" }, v({}, "b"))?.message).toBe(
      "Invalid value format.",
    );
  });

  test("db round trip", () => {
    expect(fields.password.toDb(new PasswordValue("h", "p"))).toBe("h");
    expect(fields.password.fromDb("h", pw)).toEqual(new PasswordValue("h"));
    expect(fields.password.fromDb(null, pw)).toEqual(new PasswordValue());
  });
});

describe("editor", () => {
  test.each<[unknown, string]>([
    ["", ""],
    ["test", "test"],
    [false, "false"],
    [true, "true"],
    [123.456, "123.456"],
    [null, ""],
    [{ a: 1 }, ""],
  ])("normalize %p", (input, expected) => {
    expect(stored("editor", {}, input)).toBe(expected);
  });

  test.each<[Record<string, unknown>, unknown, string | null]>([
    [{}, 123, "validation_unsupported_value_type"],
    [{}, "", null],
    [{ required: true }, "", "validation_required"],
    [{ required: true }, "abc", null],
    [
      { required: true },
      "a".repeat(1 + (5 << 20)),
      "validation_content_size_limit",
    ],
    [{ maxSize: 5 }, "abcdef", "validation_content_size_limit"],
    [{ maxSize: 5 }, "abcde", null],
    [{ maxSize: 5 }, "\u00e9\u00e9\u00e9", "validation_content_size_limit"],
  ])("validate %p %p", (opts, value, expected) => {
    expect(code("editor", opts, value)).toBe(expected);
  });

  test("message and body size", () => {
    expect(check("editor", { maxSize: 5 }, "abcdef")?.message).toBe(
      "The maximum allowed content size is 5 bytes.",
    );
    expect(fields.editor.maxBodySize!(field("editor"))).toBe(5 << 20);
    expect(fields.editor.maxBodySize!(field("editor", { maxSize: 10 }))).toBe(
      10,
    );
  });
});

describe("geoPoint", () => {
  const zero = { lon: 0, lat: 0 };

  test.each<[unknown, unknown]>([
    [null, zero],
    [undefined, zero],
    ["", zero],
    ["null", zero],
    ["nope", zero],
    [5, zero],
    [[1, 2], zero],
    [{}, zero],
    [
      { lon: 10, lat: 20 },
      { lon: 10, lat: 20 },
    ],
    ['{"lon": 10, "lat": 20}', { lon: 10, lat: 20 }],
    [
      { lon: 10, lat: 20, extra: 1 },
      { lon: 10, lat: 20 },
    ],
    [{ lon: "abc", lat: 1 }, zero],
    [
      { lat: 1, lon: "abc" },
      { lon: 0, lat: 1 },
    ],
    [
      { lon: null, lat: 4 },
      { lon: 0, lat: 4 },
    ],
    [{ Lon: 3, LAT: 4 }, zero],
  ])("normalize %p", (input, expected) => {
    expect(stored("geoPoint", {}, input)).toEqual(expected);
  });

  test.each<[Record<string, unknown>, unknown, string | null]>([
    [{}, 123, "validation_unsupported_value_type"],
    [{}, zero, null],
    [{ required: true }, zero, "validation_required"],
    [{ required: true }, { lon: 0, lat: 1 }, null],
    [{ required: true }, { lon: 1, lat: 0 }, null],
    [{ required: true }, { lon: -1, lat: -2 }, null],
    [{}, { lon: 0, lat: -90.1 }, "validation_invalid_latitude"],
    [{}, { lon: 0, lat: 90.1 }, "validation_invalid_latitude"],
    [{}, { lon: -180.1, lat: 0 }, "validation_invalid_longitude"],
    [{}, { lon: 180.1, lat: 0 }, "validation_invalid_longitude"],
    [{}, { lon: 180, lat: 90 }, null],
  ])("validate %p %p", (opts, value, expected) => {
    expect(code("geoPoint", opts, value)).toBe(expected);
  });

  test("db round trip", () => {
    const f = field("geoPoint");
    expect(fields.geoPoint.toDb({ lon: 10, lat: 20 })).toBe(
      '{"lon":10,"lat":20}',
    );
    expect(fields.geoPoint.fromDb('{"lon":10,"lat":20}', f)).toEqual({
      lon: 10,
      lat: 20,
    });
    expect(fields.geoPoint.fromDb("", f)).toEqual(zero);
    expect(fields.geoPoint.fromDb(null, f)).toEqual(zero);
  });
});
