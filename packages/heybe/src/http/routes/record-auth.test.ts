import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type App, createApp } from "../../app";
import { createRouter } from "../server";
import { createEvent } from "../router";
import { authTokenFromRequest, loadAuth } from "../middlewares";
import { newAuthToken } from "../../auth/tokens";
import { internalRecords } from "../../records/internal";

let app: App;

beforeEach(() => {
  app = createApp({ dir: ":memory:" });
});

afterEach(() => app.close());

async function call(path: string, init: RequestInit = {}) {
  const req = new Request(`http://x${path}`, { method: "POST", ...init });
  const found = createRouter()
    .build()
    .match(req.method, new URL(req.url).pathname)!;
  const e = createEvent(app, req, found.params);
  e.auth = loadAuth(app, req);
  try {
    return await found.run(e);
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

describe("auth-with-password dummy check", () => {
  test("hashes the dummy password with the collection password cost", async () => {
    const users = app.collections.find("users")!;
    await app.collections.save({
      id: users.id,
      fields: users.fields.map((f) =>
        f.name === "password" ? { ...f, cost: 7 } : f,
      ),
    } as any);
    const hash = spyOn(Bun.password, "hash");
    await call("/api/collections/users/auth-with-password", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "no@example.com", password: "pw" }),
    });
    expect(hash).toHaveBeenCalledTimes(1);
    expect(hash.mock.calls[0]![1]).toEqual({ algorithm: "bcrypt", cost: 7 });
    hash.mockRestore();
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
    await app.collections.save({ name: "posts", type: "base", fields: [] });
    const res = (await call("/api/collections/posts/auth-refresh")) as {
      status: number;
    };
    expect(res.status).toBe(401);
  });

  test("a superuser token on a base collection is 403", async () => {
    await app.collections.save({ name: "posts", type: "base", fields: [] });
    const created = await app
      .records("_superusers")
      .create({ email: "a@example.com", password: "1234567890" });
    const raw = internalRecords(app, "_superusers").findRaw(
      created.id as string,
    );
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

describe("auth response", () => {
  test("runs the enrich hooks of the auth record", async () => {
    await app.records("users").create({
      id: "u00000000000001",
      email: "a@example.com",
      password: "12345678",
    });
    const enriched: string[] = [];
    app.onRecordEnrich("users", async (e) => {
      enriched.push(e.record.id);
      expect(e.requestInfo.auth?.id).toBe("u00000000000001");
      await e.next();
      e.record.withCustomData(true);
      e.record.set("label", "enriched");
    });
    const res = (await call("/api/collections/users/auth-with-password", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "a@example.com", password: "12345678" }),
    })) as Response;
    const body = (await res.json()) as { record: Record<string, unknown> };
    expect(enriched).toEqual(["u00000000000001"]);
    expect(body.record.label).toBe("enriched");
    expect(body.record.email).toBe("a@example.com");
  });
});
