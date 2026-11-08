import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type App, createApp } from "../../app";
import { checkSuperuserIp } from "../middlewares";

let app: App;

beforeEach(() => {
  app = createApp({ dir: ":memory:" });
});

afterEach(() => app.close());

describe("superuser IP restriction", () => {
  const req = (headers: Record<string, string> = {}) =>
    new Request("http://x/api/settings", { headers });

  test("no allowlist allows every IP", () => {
    expect(() => checkSuperuserIp(app, req(), "9.9.9.9")).not.toThrow();
  });

  test("an IP outside the allowlist is 403, inside is allowed", async () => {
    await app.settings.update({ superuserIPs: ["10.0.0.0/8", "::1"] });
    expect(() => checkSuperuserIp(app, req(), "10.1.2.3")).not.toThrow();
    expect(() => checkSuperuserIp(app, req(), "::1")).not.toThrow();
    expect(() => checkSuperuserIp(app, req(), "9.9.9.9")).toThrow(
      "You are not allowed to perform this request.",
    );
  });

  test("trusted proxy headers pick the rightmost or leftmost IP", async () => {
    await app.settings.update({
      superuserIPs: ["1.1.1.1"],
      trustedProxy: { headers: ["X-Forwarded-For"], useLeftmostIP: false },
    });
    const headers = { "x-forwarded-for": "1.1.1.1, 2.2.2.2" };
    expect(() => checkSuperuserIp(app, req(headers), "1.1.1.1")).toThrow();
    await app.settings.update({ trustedProxy: { useLeftmostIP: true } });
    expect(() => checkSuperuserIp(app, req(headers), "9.9.9.9")).not.toThrow();
  });
});
