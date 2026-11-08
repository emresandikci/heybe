import { describe, expect, test } from "bun:test";
import { createClientWith } from "./client.js";
import { fakeEnv } from "./test-env.js";

function setup() {
  const env = fakeEnv();
  return { env, client: createClientWith("http://a", {}, env) };
}

const record = { id: "r1", collectionId: "c1", collectionName: "posts" };

describe("files", () => {
  test("url with collectionId, thumb and token", () => {
    const { client } = setup();
    expect(
      client.files.url(record, "a.png", { thumb: "100x100", token: "t" }),
    ).toBe("http://a/api/files/c1/r1/a.png?thumb=100x100&token=t");
  });

  test("url falls back to collectionName", () => {
    const { client } = setup();
    expect(
      client.files.url({ id: "r1", collectionName: "posts" }, "a.png"),
    ).toBe("http://a/api/files/posts/r1/a.png");
  });

  test("url encodes the filename", () => {
    const { client } = setup();
    expect(client.files.url(record, "a b/ç.png")).toBe(
      "http://a/api/files/c1/r1/a%20b%2F%C3%A7.png",
    );
  });

  test("download false is dropped", () => {
    const { client } = setup();
    expect(client.files.url(record, "a.png", { download: false })).toBe(
      "http://a/api/files/c1/r1/a.png",
    );
    expect(client.files.url(record, "a.png", { download: true })).toBe(
      "http://a/api/files/c1/r1/a.png?download=true",
    );
  });

  test('missing parts give ""', () => {
    const { client } = setup();
    expect(client.files.url(record, "")).toBe("");
    expect(client.files.url({ collectionId: "c1" }, "a.png")).toBe("");
    expect(client.files.url({ id: "r1" }, "a.png")).toBe("");
  });

  test("token posts and returns the token", async () => {
    const { env, client } = setup();
    env.respond(() => Response.json({ token: "ft" }));
    expect(await client.files.token()).toBe("ft");
    expect(env.requests[0]!.method).toBe("POST");
    expect(env.requests[0]!.url).toBe("http://a/api/files/token");
    env.respond(() => Response.json({}));
    expect(await client.files.token()).toBe("");
  });
});
