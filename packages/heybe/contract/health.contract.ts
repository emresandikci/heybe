import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { both, expectSame, startTargets } from "./harness";

let targets: Awaited<ReturnType<typeof startTargets>>;

beforeAll(async () => {
  targets = await startTargets();
}, 60_000);

afterAll(async () => {
  await targets.stop();
});

describe("health", () => {
  test("GET /api/health", async () => {
    const [pb, hb] = await both((t) => fetch(`${t.url}/api/health`));
    expect(pb.status).toBe(200);
    expectSame(pb, hb);
  });

  test.each<Record<string, string>>([{}, { "X-Forwarded-For": "5.5.5.5" }])(
    "superuser GET /api/health with %p",
    async (headers) => {
      const [pb, hb] = await both((t) =>
        fetch(`${t.url}/api/health`, {
          headers: { ...headers, authorization: t.superToken },
        }),
      );
      expect(pb.status).toBe(200);
      expect((pb.body as any).data.canBackup).toBe(true);
      expectSame(pb, hb);
    },
  );

  test("GET /api/nope returns the same 404", async () => {
    const [pb, hb] = await both((t) => fetch(`${t.url}/api/nope`));
    expect(pb.status).toBe(404);
    expectSame(pb, hb);
  });

  test("OPTIONS with an origin returns the same CORS headers", async () => {
    const [pb, hb] = await both((t) =>
      fetch(`${t.url}/api/health`, {
        method: "OPTIONS",
        headers: { Origin: "http://x.test" },
      }),
    );
    expect(pb.headers["access-control-allow-origin"]).toBe("*");
    expectSame(pb, hb);
  });

  test("a 33 MB POST body gets the same error", async () => {
    const body = new Uint8Array(33 * 1024 * 1024);
    const [pb, hb] = await both((t) =>
      fetch(`${t.url}/api/health`, { method: "POST", body }),
    );
    expect(pb.status).toBe(413);
    expectSame(pb, hb);
  });
});
