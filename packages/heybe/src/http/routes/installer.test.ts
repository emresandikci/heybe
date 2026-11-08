import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type App } from "../../app";
import { testApp } from "../../test-app";
import { authFromToken } from "../../auth/tokens";
import { INSTALLER_EMAIL } from "../../util";
import { runInstaller } from "./installer";

let app: App;

beforeEach(() => {
  app = testApp({ now: () => new Date("2026-01-01T00:00:00Z") });
});

afterEach(() => app.close());

async function install(): Promise<string[]> {
  const lines: string[] = [];
  await runInstaller(app, "http://127.0.0.1:8090/", (l) => lines.push(l));
  return lines;
}

describe("installer", () => {
  test("prints the install url whose token authenticates as a superuser", async () => {
    const lines = await install();
    const url = lines.find((l) => l.startsWith("http"))!;
    const match = url.match(
      /^http:\/\/127\.0\.0\.1:8090\/_\/#\/pbinstall\/(.+)$/,
    );
    expect(match).not.toBeNull();
    const auth = authFromToken(app, match![1])!;
    expect(auth.isSuperuser).toBe(true);
    expect(auth.record.email).toBe(INSTALLER_EMAIL);
  });

  test("the token is not refreshable and lasts 30 minutes", async () => {
    const lines = await install();
    const token = lines
      .find((l) => l.startsWith("http"))!
      .split("/")
      .pop()!;
    const claims = JSON.parse(atob(token.split(".")[1]));
    expect(claims.refreshable).toBe(false);
    expect(claims.exp).toBe(Date.parse("2026-01-01T00:30:00Z") / 1000);
  });

  test("running twice reuses the installer superuser", async () => {
    await install();
    await install();
    expect(
      app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM _superusers")!.n,
    ).toBe(1);
  });

  test("nothing is printed once a real superuser exists", async () => {
    await app
      .records("_superusers")
      .create({ email: "a@example.com", password: "1234567890" });
    expect(await install()).toEqual([]);
  });

  test("creating a real superuser removes the installer superuser", async () => {
    await install();
    await app
      .records("_superusers")
      .create({ email: "a@example.com", password: "1234567890" });
    const emails = app.db
      .query<{ email: string }>("SELECT email FROM _superusers")
      .map((r) => r.email);
    expect(emails).toEqual(["a@example.com"]);
  });
});
