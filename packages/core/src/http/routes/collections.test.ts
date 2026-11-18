import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type App } from "../../app";
import { testApp } from "../../test-app";
import { newAuthToken } from "../../auth/tokens";
import { internalRecords } from "../../records/internal";
import { loadAuth } from "../middlewares";
import { createEvent } from "../router";
import { createRouter } from "../server";

let app: App;
let seq = 0;

beforeEach(() => {
  app = testApp({ now: () => new Date("2026-01-01T00:00:00Z") });
});

afterEach(() => app.close());

async function call(
  method: string,
  path: string,
  collection: string | null,
  body?: unknown,
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (collection) {
    const records = internalRecords(app, collection);
    const created = await records.create({
      email: `a${seq++}@example.com`,
      password: "1234567890",
    });
    headers.authorization = newAuthToken(
      app,
      app.collections.find(collection)!,
      records.findRaw(created.id as string),
    );
  }
  const req = new Request(`http://x${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const found = createRouter()
    .build()
    .match(method, new URL(req.url).pathname)!;
  const e = createEvent(app, req, found.params);
  e.auth = loadAuth(app, req);
  try {
    return await found.run(e);
  } catch (err) {
    return err as { status: number; message: string };
  }
}

describe("superuser guard", () => {
  test("a request without a token is 401", async () => {
    const res = (await call("GET", "/api/collections", null)) as {
      status: number;
    };
    expect(res.status).toBe(401);
  });

  test("a record from another auth collection is 403", async () => {
    const res = (await call("GET", "/api/collections", "users")) as {
      status: number;
      message: string;
    };
    expect(res.status).toBe(403);
    expect(res.message).toBe(
      "The authorized record is not allowed to perform this action.",
    );
  });

  test("a superuser can list", async () => {
    const res = (await call(
      "GET",
      "/api/collections",
      "_superusers",
    )) as Response;
    expect(res.status).toBe(200);
  });
});

describe("create", () => {
  test("an explicit id that already exists is rejected instead of updating", async () => {
    const first = (await call("POST", "/api/collections", "_superusers", {
      name: "posts",
      id: "customid1234567",
    })) as Response;
    expect(first.status).toBe(200);
    const second = (await call("POST", "/api/collections", "_superusers", {
      name: "posts2",
      id: "customid1234567",
    })) as unknown as { status: number; data: Record<string, unknown> };
    expect(second.status).toBe(400);
    expect(second.data).toEqual({
      id: {
        code: "validation_invalid_or_existing_id",
        message: "The model id is invalid or already exists.",
      },
    });
  });
});

describe("truncate", () => {
  const rows = (table: string) =>
    app.db.query<{ id: string }>(`SELECT id FROM ${table}`).length;

  test("removes every record", async () => {
    await app.collections.save({ name: "posts" });
    for (const id of ["a", "b", "c"].map((x) => x.repeat(15)))
      await app.records("posts").create({ id });
    const res = (await call(
      "DELETE",
      "/api/collections/posts/truncate",
      "_superusers",
    )) as Response;
    expect(res.status).toBe(204);
    expect(rows("posts")).toBe(0);
  });

  test("a required reference rolls everything back", async () => {
    const target = await app.collections.save({ name: "targets" });
    await app.collections.save({
      name: "refs",
      fields: [
        {
          name: "to",
          type: "relation",
          collectionId: target.id,
          maxSelect: 1,
          required: true,
          cascadeDelete: false,
        },
      ] as any,
    });
    const ids = ["a", "b"].map((x) => x.repeat(15));
    for (const id of ids) await app.records("targets").create({ id });
    await app.records("refs").create({ to: ids[1] });
    const res = (await call(
      "DELETE",
      "/api/collections/targets/truncate",
      "_superusers",
    )) as { status: number; message: string };
    expect(res.status).toBe(400);
    expect(res.message).toBe(
      "Failed to truncate collection (most likely due to required cascade delete record references).",
    );
    expect(rows("targets")).toBe(2);
    expect(rows("refs")).toBe(1);
  });
});
