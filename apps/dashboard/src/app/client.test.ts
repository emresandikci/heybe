import { expect, test } from "bun:test";
import { fakeToken } from "../test/render";
import { AUTH_STORE_KEY, createDashboardClient } from "./client";

test("createDashboardClient uses the heybe_superuser_auth localStorage key", () => {
  const client = createDashboardClient();
  client.authStore.save(fakeToken(), {
    id: "su1",
    collectionId: "pbc_3142635823",
    collectionName: "_superusers",
  });
  expect(AUTH_STORE_KEY).toBe("heybe_superuser_auth");
  expect(localStorage.getItem("heybe_superuser_auth")).toContain("su1");
  expect(client.autoCancel).toBe(false);
});
