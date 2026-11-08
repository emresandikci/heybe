import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Target } from "../../heybe/contract/harness";
import { type SmtpCapture, startSmtpCapture } from "../../heybe/contract/smtp";
import type { HeybeClient } from "../src/client";
import { HeybeError } from "../src/error";
import { same, startPair, type Name, type Pair } from "./pair";

let pair: Pair;
let mail: Record<Name, SmtpCapture>;

const NAMES: Name[] = ["pocketbase", "heybe"];
const PASSWORD = "12345678";
const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/;

beforeAll(async () => {
  mail = {
    pocketbase: await startSmtpCapture(),
    heybe: await startSmtpCapture(),
  };
  pair = await startPair();
  for (const name of NAMES) {
    const admin = pair.admin[name];
    await admin.send("/api/settings", {
      method: "PATCH",
      body: {
        meta: {
          appName: "Acme",
          appURL: "https://app.example",
          senderName: "Acme Support",
          senderAddress: "support@example.com",
        },
        smtp: {
          enabled: true,
          host: "127.0.0.1",
          port: mail[name].port,
          tls: false,
          username: "",
          password: "",
        },
      },
    });
    await admin.send("/api/collections", {
      method: "POST",
      body: { name: "otpusers", type: "auth", otp: { enabled: true } },
    });
    await admin.send("/api/collections", {
      method: "POST",
      body: {
        name: "mfausers",
        type: "auth",
        otp: { enabled: true },
        mfa: { enabled: true, rule: "" },
      },
    });
  }
}, 60_000);

afterAll(async () => {
  await pair?.stop();
  await Promise.all(Object.values(mail ?? {}).map((capture) => capture.stop()));
});

const createUser = (t: Target, email: string, collection = "users") =>
  pair.admin[t.name].records(collection).create({
    email,
    password: PASSWORD,
    passwordConfirm: PASSWORD,
  });

async function mailed(t: Target, address: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no mail to ${address}`)), 2000);
  });
  try {
    return (await Promise.race([mail[t.name].waitFor(address), timeout])).html;
  } finally {
    clearTimeout(timer);
  }
}

const tokenIn = async (t: Target, address: string) =>
  JWT.exec(await mailed(t, address))![0];

// PB saves the OTP's sentTo after the mail is sent, and an OTP login only marks the email verified once it is set.
async function codeIn(t: Target, address: string, otpId: string) {
  const code = /<strong>(\d+)<\/strong>/.exec(await mailed(t, address))![1]!;
  const otps = pair.admin[t.name].records("_otps");
  const deadline = Date.now() + 2000;
  while (!(await otps.findOne(otpId)).sentTo)
    if (Date.now() > deadline) throw new Error(`otp ${otpId} has no sentTo`);
  return code;
}

const stored = (c: HeybeClient) => ({
  token: c.authStore.token,
  record: c.authStore.record,
});

test("methods", async () => {
  await same(pair, async (c) => [
    await c.auth("users").methods(),
    await c.auth("mfausers").methods(),
  ]);
});

test("password login, good and bad", async () => {
  await same(pair, async (c, t) => {
    await createUser(t, "login@example.com");
    const bad = await c
      .auth("users")
      .withPassword("login@example.com", "wrong-password")
      .catch((err: HeybeError) => ({ status: err.status, body: err.response }));
    const good = await c
      .auth("users")
      .withPassword("login@example.com", PASSWORD);
    return [bad, good, stored(c)];
  });
});

test("refresh", async () => {
  await same(pair, async (c, t) => {
    await createUser(t, "refresh@example.com");
    await c.auth("users").withPassword("refresh@example.com", PASSWORD);
    return [await c.auth("users").refresh(), stored(c)];
  });
});

test("OTP request and login with the mailed code", async () => {
  await same(pair, async (c, t) => {
    await createUser(t, "otp@example.com", "otpusers");
    const otp = c.auth("otpusers");
    const { otpId } = await otp.requestOTP("otp@example.com");
    const res = await otp.withOTP(
      otpId,
      await codeIn(t, "otp@example.com", otpId),
    );
    return [{ otpId }, res, stored(c)];
  });
});

test("MFA: password then OTP with mfaId", async () => {
  await same(pair, async (c, t) => {
    await createUser(t, "mfa@example.com", "mfausers");
    const mfa = c.auth("mfausers");
    const first = await mfa
      .withPassword("mfa@example.com", PASSWORD)
      .catch((err: HeybeError) => err);
    expect(first).toBeInstanceOf(HeybeError);
    const mfaId = String((first as HeybeError).response.mfaId);
    const { otpId } = await mfa.requestOTP("mfa@example.com");
    const res = await mfa.withOTP(
      otpId,
      await codeIn(t, "mfa@example.com", otpId),
      {
        mfaId,
      },
    );
    return [(first as HeybeError).response, res, stored(c)];
  });
});

test("impersonate", async () => {
  await same(pair, async (_c, t) => {
    const user = await createUser(t, "imp@example.com");
    const admin = pair.admin[t.name];
    const before = admin.authStore.token;
    const other = await admin.auth("users").impersonate(user.id, 100);
    expect(admin.authStore.token).toBe(before);
    return [stored(other), await other.records("users").findOne(user.id)];
  });
});

test("verification round trip", async () => {
  await same(pair, async (c, t) => {
    await createUser(t, "verify@example.com");
    const users = c.auth("users");
    await users.withPassword("verify@example.com", PASSWORD);
    await users.requestVerification("verify@example.com");
    await users.confirmVerification(await tokenIn(t, "verify@example.com"));
    return [
      stored(c),
      await users.withPassword("verify@example.com", PASSWORD),
    ];
  });
});

test("password reset round trip", async () => {
  await same(pair, async (c, t) => {
    await createUser(t, "reset@example.com");
    const users = c.auth("users");
    await users.requestPasswordReset("reset@example.com");
    await users.confirmPasswordReset(
      await tokenIn(t, "reset@example.com"),
      "new-password",
      "new-password",
    );
    return users.withPassword("reset@example.com", "new-password");
  });
});

test("email change round trip", async () => {
  await same(pair, async (c, t) => {
    await createUser(t, "change@example.com");
    const users = c.auth("users");
    await users.withPassword("change@example.com", PASSWORD);
    await users.requestEmailChange("changed@example.com");
    await users.confirmEmailChange(
      await tokenIn(t, "changed@example.com"),
      PASSWORD,
    );
    const cleared = stored(c);
    return [cleared, await users.withPassword("changed@example.com", PASSWORD)];
  });
});
