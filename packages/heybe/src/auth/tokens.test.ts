import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type App, createApp } from "../app";
import { signJwt, verifyJwt } from "./jwt";
import { authFromToken, newAuthToken, newFileToken } from "./tokens";

const start = new Date("2026-01-01T00:00:00.000Z");
const DAY = 86400 * 1000;

let app: App;
let clock: Date;

beforeEach(() => {
  clock = start;
  app = createApp({ dir: ":memory:", now: () => clock });
});

afterEach(() => app.close());

async function superuser(password = "1234567890") {
  return (await app.records("_superusers").create({
    email: "a@example.com",
    password,
  })) as Record<string, unknown>;
}

describe("jwt", () => {
  const now = () => clock;
  const exp = start.getTime() / 1000 + 60;

  test("verifies a valid token", () => {
    const claims = verifyJwt(
      signJwt({ id: "x", exp }, "secret"),
      "secret",
      now,
    );
    expect(claims).toEqual({ id: "x", exp });
  });

  test("rejects an expired token", () => {
    const token = signJwt({ id: "x", exp }, "secret");
    clock = new Date(start.getTime() + 61_000);
    expect(verifyJwt(token, "secret", now)).toBeNull();
  });

  test("rejects a token signed with another secret", () => {
    expect(
      verifyJwt(signJwt({ id: "x", exp }, "other"), "secret", now),
    ).toBeNull();
  });

  test("rejects alg none with an empty signature", () => {
    const b64 = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString("base64url");
    const token = `${b64({ alg: "none", typ: "JWT" })}.${b64({ id: "x", exp })}.`;
    expect(verifyJwt(token, "secret", now)).toBeNull();
  });

  test("rejects a payload changed after signing", () => {
    const [h, , s] = signJwt({ id: "x", exp }, "secret").split(".");
    const p = Buffer.from(JSON.stringify({ exp, id: "y" })).toString(
      "base64url",
    );
    expect(verifyJwt(`${h}.${p}.${s}`, "secret", now)).toBeNull();
  });
});

describe("auth tokens", () => {
  test("a new password regenerates the tokenKey", async () => {
    const created = await superuser();
    const before = app.records("_superusers").findRaw(created.id as string);
    await app
      .records("_superusers")
      .update(created.id as string, { password: "0987654321" });
    const after = app.records("_superusers").findRaw(created.id as string);
    expect(after.tokenKey).not.toBe(before.tokenKey);
  });

  test("an old token stops working after a password change", async () => {
    const created = await superuser();
    const collection = app.collections.find("_superusers")!;
    const raw = app.records("_superusers").findRaw(created.id as string);
    const token = newAuthToken(app, collection, raw);
    expect(authFromToken(app, token)?.isSuperuser).toBe(true);

    await app
      .records("_superusers")
      .update(created.id as string, { password: "0987654321" });
    expect(authFromToken(app, token)).toBeNull();
  });

  test("a token expires after the collection duration", async () => {
    const created = await superuser();
    const collection = app.collections.find("_superusers")!;
    const raw = app.records("_superusers").findRaw(created.id as string);
    const token = newAuthToken(app, collection, raw);
    clock = new Date(start.getTime() + DAY + 1000);
    expect(authFromToken(app, token)).toBeNull();
  });
});

describe("file tokens", () => {
  async function tokens() {
    const created = await superuser();
    const collection = app.collections.find("_superusers")!;
    const raw = app.records("_superusers").findRaw(created.id as string);
    return {
      file: newFileToken(app, collection, raw),
      auth: newAuthToken(app, collection, raw),
    };
  }

  test("carries the file type and the collection duration", async () => {
    const { file } = await tokens();
    const claims = JSON.parse(
      Buffer.from(file.split(".")[1]!, "base64url").toString(),
    );
    expect(claims).toMatchObject({
      type: "file",
      collectionId: app.collections.find("_superusers")!.id,
      exp: start.getTime() / 1000 + 180,
    });
    expect(authFromToken(app, file, "file")?.isSuperuser).toBe(true);
  });

  test("expires after the fileToken duration", async () => {
    const { file } = await tokens();
    clock = new Date(start.getTime() + 179_000);
    expect(authFromToken(app, file, "file")).not.toBeNull();
    clock = new Date(start.getTime() + 181_000);
    expect(authFromToken(app, file, "file")).toBeNull();
  });

  test("file and auth tokens are not interchangeable", async () => {
    const { file, auth } = await tokens();
    expect(authFromToken(app, file)).toBeNull();
    expect(authFromToken(app, auth, "file")).toBeNull();
  });
});
