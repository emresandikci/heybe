import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { own } from "../../core/contract/harness";
import { type SmtpCapture, startSmtpCapture } from "../../core/contract/smtp";
import { HeybeError } from "../src/error";
import { same, startPair, type Name, type Pair } from "./pair";

let pair: Pair;
let mail: Record<Name, SmtpCapture>;

const NAMES: Name[] = ["pocketbase", "heybe"];
const PASSWORD = "12345678";
const EMAIL = "admin-svc@example.com";

beforeAll(async () => {
  mail = {
    pocketbase: await startSmtpCapture(),
    heybe: await startSmtpCapture(),
  };
  pair = await startPair();
  for (const name of NAMES) {
    const a = pair.admin[name];
    await a.settings.update({
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
        username: "user",
        password: "secret",
      },
    });
    await a.records("users").create({
      email: EMAIL,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
  }
}, 60_000);

afterAll(async () => {
  await pair?.stop();
  await Promise.all(NAMES.map((name) => mail?.[name].stop()));
});

const field = (name: string) => ({ name, type: "text" });

test("collections lifecycle", async () => {
  await same(pair, async (_, t) => {
    const a = pair.admin[t.name];
    const created = await a.collections.create({
      name: "adm_posts",
      type: "base",
      fields: [field("title")],
    });
    const byName = await a.collections.findOne("adm_posts");
    const byId = await a.collections.findOne(created.id);
    const list = await a.collections.findMany({
      where: { name: { like: "adm_" } },
      orderBy: { name: "asc" },
    });
    const noCount = await a.collections.findMany({
      where: { name: { like: "adm_" } },
      count: false,
    });
    const updated = await a.collections.update("adm_posts", {
      fields: [field("title"), field("body")],
    });
    await a.records("adm_posts").create({ title: "x" });
    await a.collections.truncate("adm_posts");
    const afterTruncate = await a.records("adm_posts").findMany();
    await a.collections.delete("adm_posts");
    const missing = await a.collections
      .findOne("adm_posts")
      .catch((err: HeybeError) => ({ status: err.status }));
    return {
      created,
      byName,
      byId,
      list,
      noCount,
      updated,
      afterTruncate,
      missing,
    };
  });
});

test("import with and without deleteMissing", async () => {
  await same(pair, async (_, t) => {
    const a = pair.admin[t.name];
    await a.collections.create({ name: "adm_keep", type: "base" });
    const existing = (await a.collections.findMany({ perPage: 200 })).items;
    const keep = existing.filter((item) => !item.name.startsWith("adm_keep"));
    await a.collections.import([
      { name: "adm_imported", type: "base", fields: [field("t")] },
    ]);
    const merged = await a.collections.findMany({
      where: { name: { like: "adm_" } },
      orderBy: { name: "asc" },
    });
    await a.collections.import(
      [...keep, { name: "adm_imported", type: "base", fields: [field("t")] }],
      true,
    );
    const pruned = await a.collections.findMany({
      where: { name: { like: "adm_" } },
    });
    return { merged, pruned };
  });
});

test("scaffolds", async () => {
  await same(pair, async (_, t) => {
    const scaffolds = await pair.admin[t.name].collections.scaffolds();
    return JSON.parse(
      JSON.stringify(scaffolds).replace(/(idx_\w+?)_[a-z0-9]{10}/g, "$1"),
    );
  });
});

test("settings get and update mask secrets", async () => {
  await same(pair, async (_, t) => {
    const a = pair.admin[t.name];
    const portless = (settings: Record<string, unknown>) => ({
      ...settings,
      smtp: { ...(settings.smtp as object), port: undefined },
    });
    const before = portless(await a.settings.get());
    const updated = portless(
      await a.settings.update({ meta: { appName: "Renamed" } }),
    );
    return { before, updated, after: portless(await a.settings.get()) };
  });
});

test("test email reaches the mail server", async () => {
  await same(pair, async (_, t) => {
    mail[t.name].clear();
    await pair.admin[t.name].settings.testEmail("users", EMAIL, "verification");
    const received = await mail[t.name].waitFor(EMAIL);
    return { to: received.to, subject: received.subject };
  });
});

test("apple client secret", async () => {
  const privateKey = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  await same(pair, async (_, t) => {
    const { secret } = await pair.admin[
      t.name
    ].settings.generateAppleClientSecret(
      "com.example.app",
      "TEAM123456",
      "KEY1234567",
      privateKey,
      3600,
    );
    const [header, claims] = secret
      .split(".")
      .slice(0, 2)
      .map((part) => JSON.parse(Buffer.from(part, "base64url").toString()));
    return { header, claimKeys: Object.keys(claims) };
  });
  await same(pair, (_, t) =>
    pair.admin[t.name].settings
      .generateAppleClientSecret("x", "short", "k", "nope", 1)
      .catch((err: HeybeError) => ({ status: err.status, ...err.response })),
  );
});

test("crons list and run", async () => {
  await same(pair, async (_, t) => {
    const a = pair.admin[t.name];
    const missing = await a.crons
      .run("missing")
      .catch((err: HeybeError) => ({ status: err.status }));
    return {
      list: await a.crons.list(),
      run: await a.crons.run(own(t, "__pbDBOptimize__")),
      missing,
    };
  });
});

test("health", async () => {
  await same(pair, (c) => c.health.check());
});

test("a non-superuser gets 403 from every service", async () => {
  await same(pair, async (c, t) => {
    await c.auth("users").withPassword(EMAIL, PASSWORD);
    const calls: Record<string, () => Promise<unknown>> = {
      collections: () => c.collections.findMany(),
      collection: () => c.collections.findOne("users"),
      create: () => c.collections.create({ name: "adm_no", type: "base" }),
      update: () => c.collections.update("users", {}),
      truncate: () => c.collections.truncate("users"),
      delete: () => c.collections.delete("users"),
      import: () => c.collections.import([]),
      scaffolds: () => c.collections.scaffolds(),
      settings: () => c.settings.get(),
      settingsUpdate: () => c.settings.update({}),
      testEmail: () => c.settings.testEmail("users", EMAIL, "verification"),
      apple: () => c.settings.generateAppleClientSecret("a", "b", "c", "d", 1),
      cronsList: () => c.crons.list(),
      cronsRun: () => c.crons.run(own(t, "__pbDBOptimize__")),
    };
    const out: Record<string, unknown> = {};
    for (const [key, call] of Object.entries(calls))
      out[key] = await call().then(
        () => "allowed",
        (err: HeybeError) => ({ status: err.status, response: err.response }),
      );
    return out;
  });
});
