import { describe, expect, test } from "bun:test";
import { createClientWith } from "./client.js";
import { fakeEnv } from "./test-env.js";

function setup(body: unknown = {}) {
  const env = fakeEnv();
  env.respond(() => Response.json(body));
  return { env, client: createClientWith("http://a", {}, env) };
}

describe("backups", () => {
  test("list gets the backups", async () => {
    const { env, client } = setup([]);
    await client.backups.list();
    expect(env.requests.at(-1)).toMatchObject({
      method: "GET",
      url: "http://a/api/backups",
    });
  });

  test("create posts the name, or no body key without one", async () => {
    const { env, client } = setup();
    await client.backups.create("a.zip");
    expect(env.requests.at(-1)).toMatchObject({
      method: "POST",
      url: "http://a/api/backups",
      body: '{"name":"a.zip"}',
    });
    await client.backups.create();
    expect(env.requests.at(-1)!.body).toBe("{}");
  });

  test("upload posts the file as multipart", async () => {
    const { env, client } = setup();
    await client.backups.upload(new File(["x"], "b.zip"));
    const req = env.requests.at(-1)!;
    expect(req).toMatchObject({
      method: "POST",
      url: "http://a/api/backups/upload",
    });
    const file = (req.body as FormData).get("file") as File;
    expect(file.name).toBe("b.zip");
    expect(await file.text()).toBe("x");
  });

  test("delete and restore encode the key", async () => {
    const { env, client } = setup();
    await client.backups.delete("a/b.zip");
    expect(env.requests.at(-1)).toMatchObject({
      method: "DELETE",
      url: "http://a/api/backups/a%2Fb.zip",
    });
    await client.backups.restore("a/b.zip");
    expect(env.requests.at(-1)).toMatchObject({
      method: "POST",
      url: "http://a/api/backups/a%2Fb.zip/restore",
    });
  });

  test("downloadURL encodes the key and token", () => {
    const { client } = setup();
    expect(client.backups.downloadURL("t k", "a/b.zip")).toBe(
      "http://a/api/backups/a%2Fb.zip?token=t%20k",
    );
  });
});
