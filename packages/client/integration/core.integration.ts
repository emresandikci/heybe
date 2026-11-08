import { afterAll, beforeAll, expect, test } from "bun:test";
import { same, startPair, type Pair } from "./pair";

let pair: Pair;

beforeAll(async () => {
  pair = await startPair();
}, 60_000);

afterAll(async () => {
  await pair?.stop();
});

test("health check is the same", async () => {
  await same(pair, (c) => c.send("/api/health"));
});

test("unknown route error is the same", async () => {
  await same(pair, (c) => c.send("/api/nope"));
  await expect(pair.client("heybe").send("/api/nope")).rejects.toMatchObject({
    status: 404,
  });
});

test("admin client is authorized as superuser", async () => {
  await Promise.all(
    (["pocketbase", "heybe"] as const).map(async (name) => {
      const res = await pair.admin[name].send<{ items: unknown[] }>(
        "/api/collections",
      );
      expect(res).toHaveProperty("items");
    }),
  );
});
