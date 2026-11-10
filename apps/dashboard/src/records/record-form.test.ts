import { expect, test } from "bun:test";
import { collectionsFixture } from "../test/fixtures";
import {
  JsonInputError,
  initialValues,
  toInputDate,
  toServerDate,
  toWriteData,
} from "./record-form";

const posts = collectionsFixture.find((c) => c.name === "posts")!;
const users = collectionsFixture.find((c) => c.name === "users")!;

test("toServerDate and toInputDate round trip in UTC", () => {
  expect(toServerDate("2026-11-11T10:20")).toBe("2026-11-11 10:20:00.000Z");
  expect(toServerDate("2026-11-11T10:20:30")).toBe("2026-11-11 10:20:30.000Z");
  expect(toServerDate("")).toBe("");
  expect(toInputDate("2026-11-11 10:20:30.000Z")).toBe("2026-11-11T10:20:30");
  expect(toInputDate("")).toBe("");
  expect(toServerDate(toInputDate("2026-11-11 10:20:30.000Z"))).toBe(
    "2026-11-11 10:20:30.000Z",
  );
});

test("initialValues pretty prints json and converts dates", () => {
  const values = initialValues(posts, {
    meta: { a: 1 },
    when: "2026-11-11 10:20:30.000Z",
    views: 0,
    published: true,
  });
  expect(values.meta).toBe('{\n  "a": 1\n}');
  expect(values.when).toBe("2026-11-11T10:20:30");
  expect(values.views).toBe("0");
  expect(values.published).toBe(true);
  expect(values).not.toHaveProperty("cover");
});

test("toWriteData sends only changed keys on update", () => {
  const original = { title: "A", views: 3, meta: { a: 1 }, published: false };
  const values = { ...initialValues(posts, original), title: "B", views: "" };
  expect(toWriteData(posts, values, original)).toEqual({
    title: "B",
    views: null,
  });
});

test("toWriteData on create skips empty values and autodate", () => {
  const values = {
    ...initialValues(posts),
    title: "T",
    meta: '{"a": 2}',
    status: "live",
    place: { lon: "1.5", lat: "-2" },
    when: "2026-11-11T10:20",
  };
  expect(toWriteData(posts, values)).toEqual({
    title: "T",
    meta: '{"a": 2}',
    status: "live",
    place: { lon: 1.5, lat: -2 },
    when: "2026-11-11 10:20:00.000Z",
  });
});

test("invalid json throws JsonInputError with the field name", () => {
  const values = { ...initialValues(posts), meta: "{oops" };
  expect(() => toWriteData(posts, values)).toThrow(JsonInputError);
});

test("password is sent for auth collections only when typed", () => {
  const original = { email: "a@b.c" };
  const values = initialValues(users, original);
  expect(toWriteData(users, values, original)).toEqual({});
  expect(
    toWriteData(
      users,
      { ...values, password: "pw", passwordConfirm: "pw" },
      original,
    ),
  ).toEqual({ password: "pw", passwordConfirm: "pw" });
});

test("json is sent as the typed text so the server stores what was typed", () => {
  for (const text of ["42", "true", "null", "[1]", '{"a":1}', '"hi"'])
    expect(
      toWriteData(posts, { ...initialValues(posts), meta: `  ${text}\n` }),
    ).toEqual({ meta: text });
  expect(() =>
    toWriteData(posts, { ...initialValues(posts), meta: "hi" }),
  ).toThrow(JsonInputError);
});

test("an untouched date keeps its milliseconds because it is not sent", () => {
  const original = { title: "A", when: "2026-11-11 10:20:30.123Z" };
  const values = { ...initialValues(posts, original), title: "B" };
  expect(toWriteData(posts, values, original)).toEqual({ title: "B" });
});

test("the password field is found even though the server marks it hidden", () => {
  expect(initialValues(users)).toMatchObject({
    password: "",
    passwordConfirm: "",
  });
  expect(initialValues(users)).not.toHaveProperty("tokenKey");
});
