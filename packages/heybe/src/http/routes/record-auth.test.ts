import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type App, createApp } from "../../app";
import { createRouter } from "../server";
import { createEvent } from "../router";
import { authTokenFromRequest, loadAuth } from "../middlewares";
import { newAuthToken } from "../../auth/tokens";

let app: App;

beforeEach(() => {
  app = createApp({ dir: ":memory:" });
});

afterEach(() => app.close());

async function call(path: string, init: RequestInit = {}) {
  const req = new Request(`http://x${path}`, { method: "POST", ...init });
  const found = createRouter().match(req.method, new URL(req.url).pathname)!;
  const e = createEvent(app, req, found.params);
  e.auth = loadAuth(app, req);
  try {
    return await found.h(e);
  } catch (err) {
    return err as { status: number; message: string };
  }
}

describe("auth-with-password", () => {
  test("an unknown identity still runs a real compare with a non-empty password", async () => {
    await app
      .records("_superusers")
      .create({ email: "a@example.com", password: "1234567890" });
    const verify = spyOn(Bun.password, "verify");
    const res = (await call("/api/collections/_superusers/auth-with-password", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "no@example.com", password: "pw" }),
    })) as { status: number };
    expect(res.status).toBe(400);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]![0]).toBe("pw");
    verify.mockRestore();
  });
});

describe("auth-with-password multipart", () => {
  test("number-like values are read as the submitted strings", async () => {
    await app
      .records("_superusers")
      .create({ email: "a@example.com", password: "1234567890" });
    const body = new FormData();
    body.append("identity", "a@example.com");
    body.append("password", "1234567890");
    const res = (await call("/api/collections/_superusers/auth-with-password", {
      body,
    })) as Response;
    expect(res.status).toBe(200);
  });
});

describe("auth-refresh guard order", () => {
  test("unknown collection is 404 before the auth check", async () => {
    const res = (await call("/api/collections/nope/auth-refresh")) as {
      status: number;
      message: string;
    };
    expect(res.status).toBe(404);
    expect(res.message).toBe("Missing or invalid collection context.");
  });

  test("a base collection without a token is 401", async () => {
    app.collections.save({ name: "posts", type: "base", fields: [] });
    const res = (await call("/api/collections/posts/auth-refresh")) as {
      status: number;
    };
    expect(res.status).toBe(401);
  });

  test("a superuser token on a base collection is 403", async () => {
    app.collections.save({ name: "posts", type: "base", fields: [] });
    const created = await app
      .records("_superusers")
      .create({ email: "a@example.com", password: "1234567890" });
    const raw = app.records("_superusers").findRaw(created.id as string);
    const token = newAuthToken(app, app.collections.find("_superusers")!, raw);
    expect(
      authTokenFromRequest(
        new Request("http://x", { headers: { authorization: token } }),
      ),
    ).toBe(token);
    const res = (await call("/api/collections/posts/auth-refresh", {
      headers: { authorization: token },
    })) as { status: number; message: string };
    expect(res.status).toBe(403);
    expect(res.message).toBe(
      "The request requires auth record from _superusers collection.",
    );
  });
});
