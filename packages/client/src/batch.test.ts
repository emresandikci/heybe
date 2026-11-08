import { describe, expect, test } from "bun:test";
import { createClientWith } from "./client.js";
import { fakeEnv } from "./test-env.js";

function setup() {
  const env = fakeEnv();
  env.respond(() => Response.json([{ status: 200, body: { id: "x" } }]));
  return { env, client: createClientWith("http://a", {}, env) };
}

const sent = (env: ReturnType<typeof fakeEnv>) => {
  const form = env.requests[0]!.body as FormData;
  return {
    form,
    requests: JSON.parse(form.get("@jsonPayload") as string).requests,
  };
};

describe("batch", () => {
  test("jsonPayload carries method, url and body per request in order", async () => {
    const { env, client } = setup();
    const batch = client.batch();
    const posts = batch.records("posts");
    posts.create({ title: "a" });
    posts.update("i/d", { title: "b" });
    posts.upsert({ id: "u", title: "c" });
    posts.delete("d1");
    await batch.send();
    expect(env.requests[0]!.method).toBe("POST");
    expect(env.requests[0]!.url).toBe("http://a/api/batch");
    expect(sent(env).requests).toEqual([
      {
        method: "POST",
        url: "/api/collections/posts/records",
        headers: {},
        body: { title: "a" },
      },
      {
        method: "PATCH",
        url: "/api/collections/posts/records/i%2Fd",
        headers: {},
        body: { title: "b" },
      },
      {
        method: "PUT",
        url: "/api/collections/posts/records",
        headers: {},
        body: { id: "u", title: "c" },
      },
      {
        method: "DELETE",
        url: "/api/collections/posts/records/d1",
        headers: {},
        body: {},
      },
    ]);
  });

  test("files go to requests.i.key", async () => {
    const { env, client } = setup();
    const batch = client.batch();
    const posts = batch.records("posts");
    const a = new File(["a"], "a.txt");
    const b = new File(["b"], "b.txt");
    const c = new File(["c"], "c.txt");
    posts.create({ title: "x" });
    posts.create({ title: "y", cover: a, docs: [b, c] });
    await batch.send();
    const { form, requests } = sent(env);
    expect(requests[1].body).toEqual({ title: "y" });
    expect((form.get("requests.1.cover") as File).name).toBe("a.txt");
    expect(form.getAll("requests.1.docs").map((f) => (f as File).name)).toEqual(
      ["b.txt", "c.txt"],
    );
    expect(form.has("requests.0.cover")).toBe(false);
  });

  test("mixed array keeps names in body and files under key+", async () => {
    const { env, client } = setup();
    const batch = client.batch();
    batch
      .records("posts")
      .update("i", { docs: ["old.txt", new File(["n"], "n.txt")] });
    batch
      .records("posts")
      .update("j", { "docs+": ["old.txt", new File(["m"], "m.txt")] });
    await batch.send();
    const { form, requests } = sent(env);
    expect(requests[0].body).toEqual({ docs: ["old.txt"] });
    expect((form.get("requests.0.docs+") as File).name).toBe("n.txt");
    expect(requests[1].body).toEqual({ "docs+": ["old.txt"] });
    expect((form.get("requests.1.docs+") as File).name).toBe("m.txt");
  });

  test("expand is serialized into the url", async () => {
    const { env, client } = setup();
    const batch = client.batch();
    batch.records("posts").create({ title: "a" }, { expand: { author: true } });
    await batch.send();
    expect(sent(env).requests[0].url).toBe(
      "/api/collections/posts/records?expand=author",
    );
  });

  test("results are returned as sent by the server", async () => {
    const { client } = setup();
    const batch = client.batch();
    batch.records("posts").create({ title: "a" });
    expect(await batch.send()).toEqual([{ status: 200, body: { id: "x" } }]);
  });
});
