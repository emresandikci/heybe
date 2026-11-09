import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type App } from "../../app";
import { newAuthToken } from "../../auth/tokens";
import { type FakeS3, startFakeS3 } from "../../files/test-s3";
import { internalRecords } from "../../records/internal";
import { testApp } from "../../test-app";
import { checkSuperuserIp, loadAuth } from "../middlewares";
import { createEvent } from "../router";
import { createRouter } from "../server";

let app: App;

beforeEach(() => {
  app = testApp();
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

describe("POST /api/settings/test/s3", () => {
  let s3: FakeS3;
  let token: string;

  beforeEach(async () => {
    s3 = await startFakeS3();
    const records = internalRecords(app, "_superusers");
    const created = await records.create({
      email: "s3@example.com",
      password: "1234567890",
    });
    token = newAuthToken(
      app,
      app.collections.find("_superusers")!,
      records.findRaw(created.id as string),
    );
  });

  afterEach(() => s3.stop());

  const s3Config = (bucket: string) => ({
    enabled: true,
    bucket,
    region: "us-east-1",
    endpoint: s3.endpoint,
    accessKey: "key",
    secret: "secret",
    forcePathStyle: true,
  });

  async function testS3(body?: string, superuser = true) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (superuser) headers.authorization = token;
    const req = new Request("http://x/api/settings/test/s3", {
      method: "POST",
      headers,
      body,
    });
    const found = createRouter()
      .build()
      .match("POST", "/api/settings/test/s3")!;
    const e = createEvent(app, req, found.params);
    e.auth = loadAuth(app, req);
    try {
      const res = await found.run(e);
      return { status: res.status };
    } catch (err) {
      const { status, message, data } = err as {
        status: number;
        message: string;
        data: unknown;
      };
      return { status, message, data };
    }
  }

  const failed = "Failed to test the S3 filesystem.";

  test("requires a superuser", async () => {
    expect((await testS3('{"filesystem":"storage"}', false)).status).toBe(401);
  });

  test("filesystem is required and must be storage or backups", async () => {
    expect(await testS3()).toEqual({
      status: 400,
      message: failed,
      data: {
        filesystem: {
          code: "validation_required",
          message: "Cannot be blank.",
        },
      },
    });
    expect(await testS3('{"filesystem":"nope"}')).toEqual({
      status: 400,
      message: failed,
      data: {
        filesystem: {
          code: "validation_in_invalid",
          message: "Must be a valid value.",
        },
      },
    });
    expect(await testS3('{"filesystem":1}')).toMatchObject({
      status: 400,
      message: "An error occurred while loading the submitted data.",
    });
  });

  test("a disabled config is a 400", async () => {
    expect(await testS3('{"filesystem":"storage"}')).toEqual({
      status: 400,
      message: `${failed} Raw error: \nS3 storage filesystem is not enabled.`,
      data: {},
    });
  });

  test("uploads and deletes a test file on storage and backups", async () => {
    await app.settings.update({
      s3: s3Config("st"),
      backups: { s3: s3Config("bk") },
    });
    expect(await testS3('{"filesystem":"storage"}')).toEqual({ status: 204 });
    expect(await testS3('{"filesystem":"backups"}')).toEqual({ status: 204 });
    const puts = s3.requests.filter((r) => r.method === "PUT");
    expect(puts.map((r) => r.path)).toEqual([
      expect.stringMatching(
        /^\/st\/pb_settings_test_[a-zA-Z0-9]{5}\/test\.txt$/,
      ),
      expect.stringMatching(
        /^\/bk\/pb_settings_test_[a-zA-Z0-9]{5}\/test\.txt$/,
      ),
    ]);
    expect(s3.objects("st").size).toBe(0);
    expect(s3.objects("bk").size).toBe(0);
  });

  test("an S3 failure on upload or delete is a 400 with the raw error", async () => {
    await app.settings.update({ s3: s3Config("st") });
    s3.failNext(500, "InternalError");
    expect(await testS3('{"filesystem":"storage"}')).toEqual({
      status: 400,
      message: `${failed} Raw error: \nfailed to upload a test file: InternalError error.`,
      data: {},
    });

    const push = s3.requests.push.bind(s3.requests);
    s3.requests.push = (...items) => {
      if (items[0]?.method === "GET") s3.failNext(500, "InternalError");
      return push(...items);
    };
    expect(await testS3('{"filesystem":"storage"}')).toEqual({
      status: 400,
      message: `${failed} Raw error: \nfailed to delete a test file: InternalError error.`,
      data: {},
    });
  });
});
