import { describe, expect, test } from "bun:test";
import { ApiError } from "./errors";
import { parseMultipart } from "./multipart";

const request = (entries: [string, string | File][]) => {
  const form = new FormData();
  for (const [k, v] of entries) form.append(k, v);
  return new Request("http://x/", { method: "POST", body: form });
};

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error("expected an ApiError");
}

describe("parseMultipart", () => {
  test("plain values are inferred like PB and repeated keys become arrays", async () => {
    const body = await parseMultipart(
      request([
        ["t", "true"],
        ["f", "false"],
        ["n", "-12.5"],
        ["kept", "1.0"],
        ["empty", ""],
        ["s", "abc"],
        ["tags", "a"],
        ["tags", "2"],
      ]),
      1 << 20,
    );
    expect(body).toEqual({
      t: true,
      f: false,
      n: -12.5,
      kept: "1.0",
      empty: "",
      s: "abc",
      tags: ["a", 2],
    });
  });

  test("file parts are File values, after the plain values of the same key", async () => {
    const a = new File(["a"], "a.txt");
    const b = new File(["b"], "b.txt");
    const body = await parseMultipart(
      request([
        ["one", a],
        ["many", b],
        ["many", "old.txt"],
        ["many", a],
      ]),
      1 << 20,
    );
    expect(body.one).toBeInstanceOf(File);
    expect((body.one as File).name).toBe("a.txt");
    const many = body.many as unknown[];
    expect(many[0]).toBe("old.txt");
    expect(many.slice(1).map((f) => (f as File).name)).toEqual([
      "b.txt",
      "a.txt",
    ]);
  });

  test("__proto__ keys stay own properties and do not replace the prototype", async () => {
    const body = await parseMultipart(
      request([
        ["__proto__", "x"],
        ["@jsonPayload", '{"__proto__":{"title":"polluted"},"a":1}'],
      ]),
      1 << 20,
    );
    expect(Object.keys(body).sort()).toEqual(["__proto__", "a"]);
    expect(body.title).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(body, "__proto__")?.value).toEqual({
      title: "polluted",
    });
  });

  test("@jsonPayload overrides plain values and keeps files", async () => {
    const body = await parseMultipart(
      request([
        ["title", "plain"],
        ["other", "x"],
        ["@jsonPayload", JSON.stringify({ title: { a: 1 }, files: ["k"] })],
        ["files", new File(["f"], "f.txt")],
      ]),
      1 << 20,
    );
    expect(body.title).toEqual({ a: 1 });
    expect(body.other).toBe("x");
    expect(body).not.toHaveProperty("@jsonPayload");
    const files = body.files as unknown[];
    expect(files[0]).toBe("k");
    expect(files[1]).toBeInstanceOf(File);
  });

  test("a null @jsonPayload drops the plain values but not the files", async () => {
    const body = await parseMultipart(
      request([
        ["title", "plain"],
        ["@jsonPayload", "null"],
        ["file", new File(["f"], "f.txt")],
      ]),
      1 << 20,
    );
    expect(Object.keys(body)).toEqual(["file"]);
  });

  test("1000 parts parse, one more is PB's 400", async () => {
    const parts = (n: number) =>
      Array.from({ length: n }, (): [string, string] => ["tags", "a"]);
    const body = await parseMultipart(request(parts(1000)), 1 << 20);
    expect(body.tags).toHaveLength(1000);
    const err = await apiError(parseMultipart(request(parts(1001)), 1 << 20));
    expect(err.status).toBe(400);
    expect(err.message).toBe(
      "Something went wrong while processing your request.",
    );
  });

  test("an invalid @jsonPayload is a 400", async () => {
    for (const payload of ["{", "[1]", "1"]) {
      const err = await apiError(
        parseMultipart(request([["@jsonPayload", payload]]), 1 << 20),
      );
      expect(err.status).toBe(400);
    }
  });

  test("a body over the limit is rejected while reading", async () => {
    let pulls = 0;
    const chunk = new Uint8Array(1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(chunk);
      },
    });
    const req = new Request("http://x/", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body,
    });
    const err = await apiError(parseMultipart(req, 4096));
    expect(err.status).toBe(413);
    expect(pulls).toBeLessThan(10);
  });
});
