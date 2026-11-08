import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type App, createApp } from "./app";
import { SettingsLoadError } from "./settings";

let app: App;

beforeEach(() => {
  app = createApp({ dir: ":memory:" });
});

afterEach(() => app.close());

const errorsOf = (patch: object): Record<string, any> => {
  try {
    app.settings.update(patch);
  } catch (err) {
    return (err as { data: Record<string, any> }).data;
  }
  throw new Error("expected a validation error");
};

describe("settings", () => {
  test("defaults", () => {
    const s = app.settings.get();
    expect(s.meta.appName).toBe("Acme");
    expect(s.smtp.port).toBe(587);
    expect(s.rateLimits.rules).toHaveLength(4);
    expect(s.logs).toEqual({
      maxDataSize: 0,
      maxDays: 5,
      minLevel: 0,
      logIP: true,
      logAuthId: false,
    });
  });

  test("update merges nested fields and persists", () => {
    app.settings.update({ meta: { appName: "Mine" } } as never);
    const s = app.settings.get();
    expect(s.meta.appName).toBe("Mine");
    expect(s.meta.senderName).toBe("Support");
  });

  test("keys match case-insensitively and unknown keys are ignored", () => {
    app.settings.update({ Meta: { AppName: "Z", nope: 1 }, other: 1 } as never);
    expect(app.settings.get().meta.appName).toBe("Z");
  });

  test("Object.prototype names are ignored as unknown keys", () => {
    const patch = JSON.parse(
      '{"constructor":1,"toString":{},"meta":{"valueOf":{},"appName":"P"},"__proto__":{"x":1}}',
    );
    app.settings.update(patch);
    const json = JSON.parse(JSON.stringify(app.settings));
    const fresh = createApp({ dir: ":memory:" });
    const defaults = JSON.parse(JSON.stringify(fresh.settings));
    fresh.close();
    expect(Object.keys(json).sort()).toEqual(Object.keys(defaults).sort());
    expect(json.meta.appName).toBe("P");
    expect(Object.hasOwn(json.meta, "valueOf")).toBe(false);
  });

  test("null zeroes a field and arrays are replaced", () => {
    app.settings.update({
      smtp: { port: null },
      trustedProxy: { headers: ["X-Real-IP"] },
    } as never);
    expect(app.settings.get().smtp.port).toBe(0);
    expect(app.settings.get().trustedProxy.headers).toEqual(["X-Real-IP"]);
    app.settings.update({ trustedProxy: { headers: null } } as never);
    expect(app.settings.get().trustedProxy.headers).toEqual([]);
  });

  test("wrong types are load errors", () => {
    for (const patch of [
      { meta: "x" },
      { meta: { appName: 5 } },
      { smtp: { port: "587" } },
      { smtp: { port: 587.5 } },
      { superuserIPs: [1] },
      [1],
    ])
      expect(() => app.settings.update(patch as never)).toThrow(
        SettingsLoadError,
      );
  });

  test("a failed update changes nothing", () => {
    expect(() =>
      app.settings.update({ meta: { appName: "" } } as never),
    ).toThrow();
    expect(app.settings.get().meta.appName).toBe("Acme");
  });

  test("validation errors", () => {
    expect(
      errorsOf({
        meta: { appURL: "nope", senderAddress: "bad", accentColor: "red" },
      }),
    ).toEqual({
      meta: {
        accentColor: {
          code: "validation_length_invalid",
          message: "The length must be exactly 7.",
          params: { min: 7, max: 7 },
        },
        appURL: { code: "validation_is_url", message: "Must be a valid URL." },
        senderAddress: {
          code: "validation_is_email",
          message: "Must be a valid email address.",
        },
      },
    });
    expect(errorsOf({ smtp: { enabled: true, host: "", port: 0 } })).toEqual({
      smtp: {
        host: { code: "validation_required", message: "Cannot be blank." },
        port: { code: "validation_required", message: "Cannot be blank." },
      },
    });
    expect(errorsOf({ superuserIPs: ["1.2.3.4", "bad", ""] })).toEqual({
      superuserIPs: {
        1: {
          code: "validation_invlaid_ip_or_subnet",
          message: "Invalid IP or CIDR subnet.",
        },
        2: { code: "validation_required", message: "Cannot be blank." },
      },
    });
    expect(
      errorsOf({ backups: { cron: "bad", cronMaxKeep: 0 } }).backups,
    ).toEqual({
      cron: {
        code: "validation_invalid_cron",
        message:
          "invalid cron expression - must be a valid macro or to have exactly 5 space separated segments",
      },
      cronMaxKeep: { code: "validation_required", message: "Cannot be blank." },
    });
  });

  test("rate limit rules are validated and conflicts are reported", () => {
    expect(
      errorsOf({
        rateLimits: {
          rules: [
            { label: "/api/x", duration: 1, maxRequests: 1 },
            { label: "/api/x", duration: 1, maxRequests: 1 },
          ],
        },
      }),
    ).toEqual({
      rateLimits: {
        rules: {
          1: {
            label: {
              code: "validation_conflicting_rate_limit_rule",
              message:
                "Rate limit rule configuration with label /api/x already exists or conflicts with another rule.",
              params: { label: "/api/x" },
            },
          },
        },
      },
    });
    expect(
      errorsOf({ rateLimits: { rules: [{ label: "a b", audience: "x" }] } }),
    ).toEqual({
      rateLimits: {
        rules: {
          0: {
            audience: {
              code: "validation_in_invalid",
              message: "Must be a valid value.",
            },
            duration: {
              code: "validation_required",
              message: "Cannot be blank.",
            },
            label: {
              code: "validation_match_invalid",
              message: "Must be in a valid format.",
            },
            maxRequests: {
              code: "validation_required",
              message: "Cannot be blank.",
            },
          },
        },
      },
    });
  });

  test("secrets are stored but never serialized", () => {
    app.settings.update({
      smtp: { password: "p" },
      s3: { secret: "s" },
      backups: { s3: { secret: "b" } },
    } as never);
    const s = app.settings.get();
    expect([s.smtp.password, s.s3.secret, s.backups.s3.secret]).toEqual([
      "p",
      "s",
      "b",
    ]);
    const json = JSON.parse(JSON.stringify(app.settings));
    expect(json.smtp).not.toHaveProperty("password");
    expect(json.s3).not.toHaveProperty("secret");
    expect(json.backups.s3).not.toHaveProperty("secret");
    expect(json.smtp.host).toBe("smtp.example.com");
  });

  test("settings survive reopening the database", () => {
    const dir = mkdtempSync(join(tmpdir(), "heybe-settings-"));
    const first = createApp({ dir });
    first.settings.update({ meta: { appName: "Kept" } } as never);
    first.close();
    const second = createApp({ dir });
    expect(second.settings.get().meta.appName).toBe("Kept");
    second.close();
    rmSync(dir, { recursive: true });
  });
});
