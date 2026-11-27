import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import {
  type Snapshot,
  type Target,
  SUPERUSER_EMAIL,
  SUPERUSER_PASSWORD,
  expectSame,
  normalize,
  startHeybe,
  startPocketBase,
  verifySha256,
} from "./harness";
import { type SmtpCapture, startSmtpCapture } from "./smtp";

type Json = Record<string, any>;
type Started = Target & { stop(): Promise<void> };

const CLI = resolve(import.meta.dir, "../src/cli.ts");
const ASCII_PASSWORD = "12345678";
// 35 two-byte letters and one ASCII character: 71 bytes, the longest PB accepts
const TURKISH_PASSWORD = `${"şğüıöçŞĞÜİÖÇ".repeat(3).slice(0, 35)}a`;
const VISIBLE_PASSWORD = "visible-pass";
const USERS = [
  { email: "ascii@example.com", password: ASCII_PASSWORD, visible: false },
  { email: "turkish@example.com", password: TURKISH_PASSWORD, visible: false },
  { email: "visible@example.com", password: VISIBLE_PASSWORD, visible: true },
];

let smtp: SmtpCapture;
let pbDir: string;
let hbDir: string;
let pb: Started;
let hb: Started;
let png: Buffer;
let userToken = "";
let superToken = "";
let userIds: string[] = [];

const api = (
  t: Target,
  method: string,
  path: string,
  body?: Json | FormData,
  token: string | null = t.superToken,
) =>
  fetch(`${t.url}${path}`, {
    method,
    headers: {
      ...(body && !(body instanceof FormData)
        ? { "content-type": "application/json" }
        : {}),
      ...(token === null ? {} : { authorization: token }),
    },
    body:
      body instanceof FormData || body === undefined
        ? body
        : JSON.stringify(body),
  });

const ok = async (res: Response): Promise<Json> => {
  if (!res.ok) throw new Error(`${res.url} failed: ${await res.text()}`);
  return (await res.json()) as Json;
};

const snap = async (t: Target, path: string): Promise<Snapshot> => {
  const res = await api(t, "GET", path);
  return {
    status: res.status,
    headers: {},
    body: normalize(t.name, await res.json()),
  };
};

const run = async (cmd: string[]) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed: ${err}`);
};

const login = (t: Target, collection: string, identity: string, pass: string) =>
  api(
    t,
    "POST",
    `/api/collections/${collection}/auth-with-password`,
    { identity, password: pass },
    null,
  );

async function seedPocketBase(t: Target) {
  await ok(
    await api(t, "PATCH", "/api/settings", {
      meta: {
        appName: "Imported",
        senderAddress: "noreply@example.com",
        senderName: "Imported",
      },
      smtp: {
        enabled: true,
        host: "127.0.0.1",
        port: smtp.port,
        tls: false,
        username: "mailer",
        password: "smtp-secret",
      },
      batch: { enabled: true },
    }),
  );
  await ok(
    await api(t, "PATCH", "/api/collections/users", {
      otp: { enabled: true },
    }),
  );
  const users = await ok(await api(t, "GET", "/api/collections/users"));
  await ok(
    await api(t, "POST", "/api/collections", {
      name: "posts",
      type: "base",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "views", type: "number" },
        { name: "published", type: "bool" },
        { name: "meta", type: "json" },
        {
          name: "tags",
          type: "select",
          maxSelect: 3,
          values: ["a", "b", "c"],
        },
        {
          name: "authors",
          type: "relation",
          collectionId: users.id,
          maxSelect: 5,
        },
        { name: "images", type: "file", maxSelect: 5, thumbs: ["2x2"] },
        { name: "when", type: "date" },
        { name: "place", type: "geoPoint" },
        { name: "body", type: "editor" },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_posts_title ON posts (title)"],
    }),
  );
  await ok(
    await api(t, "POST", "/api/collections", {
      name: "post_titles",
      type: "view",
      viewQuery: "SELECT id, title FROM posts",
    }),
  );
  userIds = [];
  for (const u of USERS) {
    const rec = await ok(
      await api(t, "POST", "/api/collections/users/records", {
        email: u.email,
        password: u.password,
        passwordConfirm: u.password,
        emailVisibility: u.visible,
      }),
    );
    userIds.push(rec.id);
  }
  for (const [i, title] of ["first", "second"].entries()) {
    const data = new FormData();
    data.set("title", title);
    data.set("views", String(i + 1));
    data.set("published", "true");
    data.set("meta", JSON.stringify({ n: i }));
    data.append("tags", "a");
    data.append("tags", "c");
    data.append("authors", userIds[i]!);
    data.set("when", "2024-05-06 07:08:09.000Z");
    data.set("place", JSON.stringify({ lon: 28.97, lat: 41.01 }));
    data.set("body", "<p>hello</p>");
    data.append(
      "images",
      new File([Uint8Array.from(png)], `pic${i}.png`, { type: "image/png" }),
    );
    await ok(await api(t, "POST", "/api/collections/posts/records", data));
  }
  await ok(
    await api(
      t,
      "POST",
      "/api/collections/users/request-otp",
      { email: USERS[0]!.email },
      null,
    ),
  );
  const res = await ok(
    await login(t, "users", USERS[0]!.email, ASCII_PASSWORD),
  );
  userToken = res.token;
  superToken = t.superToken;
}

beforeAll(async () => {
  smtp = await startSmtpCapture();
  png = await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 200, g: 20, b: 20 },
    },
  })
    .png()
    .toBuffer();
  pbDir = await mkdtemp(join(tmpdir(), "hb-import-pb-"));
  hbDir = await mkdtemp(join(tmpdir(), "hb-import-hb-"));
  const seeded = await startPocketBase(pbDir);
  try {
    await seedPocketBase(seeded);
  } finally {
    await seeded.stop();
  }
  await run([
    "bun",
    CLI,
    "import",
    pbDir,
    "--dir",
    hbDir,
    "--migrationsDir",
    join(hbDir, "hb_migrations"),
  ]);
  pb = await startPocketBase(pbDir);
  hb = await startHeybe(hbDir);
}, 120_000);

afterAll(async () => {
  await Promise.all([pb?.stop(), hb?.stop(), smtp?.stop()]);
  await Promise.all(
    [pbDir, hbDir].map((d) => rm(d, { recursive: true, force: true })),
  );
});

const same = async (path: string) =>
  expectSame(await snap(pb, path), await snap(hb, path));

describe("import from PocketBase", () => {
  test("the same records, views and collections come back", async () => {
    await same("/api/collections?sort=name&perPage=100");
    await same("/api/collections/posts/records?sort=title");
    await same("/api/collections/post_titles/records?sort=title");
    await same("/api/collections/users/records?sort=email");
    await same("/api/collections/_otps/records");
  });

  test("every user logs in with the old password on Heybe", async () => {
    for (const u of USERS) {
      const res = await login(hb, "users", u.email, u.password);
      expect(res.status).toBe(200);
      expect((await res.json()).record.id).toBe(userIds[USERS.indexOf(u)]);
    }
    expect(
      (await login(hb, "users", USERS[0]!.email, "wrong-pass")).status,
    ).toBe(400);
  });

  test("a token PocketBase issued refreshes on Heybe", async () => {
    const res = await api(
      hb,
      "POST",
      "/api/collections/users/auth-refresh",
      undefined,
      userToken,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).record.id).toBe(userIds[0]);
  });

  test("the superuser logs in", async () => {
    const res = await login(
      hb,
      "_superusers",
      SUPERUSER_EMAIL,
      SUPERUSER_PASSWORD,
    );
    expect(res.status).toBe(200);
    const refresh = await api(
      hb,
      "POST",
      "/api/collections/_superusers/auth-refresh",
      undefined,
      superToken,
    );
    expect(refresh.status).toBe(200);
  });

  test("files and thumbs are served", async () => {
    const list = await ok(
      await api(hb, "GET", "/api/collections/posts/records?sort=title"),
    );
    for (const rec of list.items) {
      const url = `/api/files/posts/${rec.id}/${rec.images[0]}`;
      const original = await fetch(`${hb.url}${url}`);
      expect(Buffer.from(await original.arrayBuffer()).equals(png)).toBe(true);
      const thumb = await fetch(`${hb.url}${url}?thumb=2x2`);
      expect(thumb.status).toBe(200);
      expect(thumb.headers.get("content-type")).toBe("image/png");
      const info = await sharp(
        Buffer.from(await thumb.arrayBuffer()),
      ).metadata();
      expect([info.width, info.height]).toEqual([2, 2]);
    }
  });

  test("settings match without secrets", async () => {
    await same("/api/settings");
  });

  test("a wrong checksum is rejected", async () => {
    const file = join(pbDir, "download.zip");
    await writeFile(file, "not the real zip");
    await expect(verifySha256(file, "0".repeat(64))).rejects.toThrow(
      "PocketBase download checksum mismatch: download.zip",
    );
  });
});
