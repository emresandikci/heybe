import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type App } from "../app";
import { testApp } from "../test-app";
import type { MailMessage } from "../mail/mailer";
import { RecordModel } from "../records/model";
import { recordAuthOrigin, sendAuthAlert } from "./alerts";

let app: App;
let sent: MailMessage[];
let record: Record<string, unknown>;

const users = () => app.collections.find("users")!;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const login = async (ip: string, agent: string) => {
  await recordAuthOrigin(app, users(), record, ip, agent);
  await tick();
};
const origins = () =>
  app.db.query("SELECT id FROM _authOrigins WHERE recordRef = ?", [
    record.id as string,
  ]);

beforeEach(async () => {
  app = testApp({ now: () => new Date("2026-01-01T00:00:00Z") });
  sent = [];
  app.mailer = { send: async (msg) => void sent.push(msg) };
  record = await app
    .records("users")
    .create({ email: "a@example.com", password: "12345678" });
});

afterEach(() => app.close());

describe("recordAuthOrigin", () => {
  test("the first login only records the origin", async () => {
    await login("1.1.1.1", "agent");
    expect(sent).toHaveLength(0);
    expect(origins()).toHaveLength(1);
  });

  test("a new origin sends one alert with the escaped login info", async () => {
    await login("1.1.1.1", "agent");
    await login("2.2.2.2", "<b>agent</b>");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual([{ address: "a@example.com" }]);
    expect(sent[0]!.html).toContain(
      "2026-01-01 00:00:00.000Z - 2.2.2.2 &lt;b&gt;agent&lt;/b&gt;",
    );
    await login("2.2.2.2", "<b>agent</b>");
    expect(sent).toHaveLength(1);
    expect(origins()).toHaveLength(2);
  });

  test("a failed send leaves no origin so the next login alerts again", async () => {
    await login("1.1.1.1", "agent");
    app.mailer = {
      send: async () => {
        throw new Error("smtp down");
      },
    };
    await expect(login("2.2.2.2", "agent")).rejects.toThrow("smtp down");
    expect(origins()).toHaveLength(1);
    app.mailer = { send: async (msg) => void sent.push(msg) };
    await login("2.2.2.2", "agent");
    expect(sent).toHaveLength(1);
    expect(origins()).toHaveLength(2);
  });

  test("a send that never finishes hits the timeout and saves nothing", async () => {
    await login("1.1.1.1", "agent");
    app.mailer = { send: () => new Promise<void>(() => {}) };
    await expect(
      recordAuthOrigin(app, users(), record, "2.2.2.2", "agent", 0),
    ).rejects.toThrow("timeout");
    expect(origins()).toHaveLength(1);
  });

  test("keeps at most 5 origins, dropping the oldest", async () => {
    for (let i = 1; i <= 7; i++) await login(`1.1.1.${i}`, "agent");
    expect(origins()).toHaveLength(5);
  });

  test("a password change deletes the origins", async () => {
    await login("1.1.1.1", "agent");
    await app
      .records("users")
      .update(record.id as string, { password: "87654321" });
    expect(origins()).toHaveLength(0);
  });
});

describe("sendAuthAlert", () => {
  test("a record without an email throws missing record email", async () => {
    const record = new RecordModel(
      app.collections.find("users")!,
      { id: "r1", email: "" },
      false,
    );
    await expect(sendAuthAlert(app, record, "info")).rejects.toThrow(
      "missing record email",
    );
  });
});
