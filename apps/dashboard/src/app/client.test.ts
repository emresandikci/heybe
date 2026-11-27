import { expect, test } from "bun:test";
import { memoryStore } from "@heybejs/client";
import { fakeServer } from "../test/fake-server";
import { SUPERUSER, fakeToken } from "../test/render";
import {
  AUTH_STORE_KEY,
  createDashboardClient,
  onUnauthorized,
} from "./client";

test("createDashboardClient uses the heybe_superuser_auth localStorage key", () => {
  const client = createDashboardClient();
  client.authStore.save(fakeToken(), {
    id: "su1",
    collectionId: "hbc_3142635823",
    collectionName: "_superusers",
  });
  expect(AUTH_STORE_KEY).toBe("heybe_superuser_auth");
  expect(localStorage.getItem("heybe_superuser_auth")).toContain("su1");
  expect(client.autoCancel).toBe(false);
});

test("only 401s for the session's own token call the unauthorized handler, once", async () => {
  const server = fakeServer().on(
    "GET",
    "/api/x",
    { code: 401, message: "No.", data: {} },
    401,
  );
  const client = createDashboardClient({
    fetch: server.fetch,
    authStore: memoryStore(),
  });
  let calls = 0;
  onUnauthorized(client, () => {
    calls++;
    client.authStore.clear();
  });
  client.authStore.save(fakeToken(), { ...SUPERUSER });

  await client
    .send("/api/x", { headers: { Authorization: "installer" } })
    .catch(() => undefined);
  expect(calls).toBe(0);

  await Promise.all([
    client.send("/api/x").catch(() => undefined),
    client.send("/api/x").catch(() => undefined),
  ]);
  expect(calls).toBe(1);
});
