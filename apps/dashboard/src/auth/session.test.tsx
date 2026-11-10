import { expect, test } from "bun:test";
import { memoryStore } from "@heybe/client";
import { MutationObserver } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import { createDashboardClient } from "../app/client";
import { fakeServer } from "../test/fake-server";
import { SUPERUSER, fakeToken, renderApp } from "../test/render";
import { isSuperuserSession, refreshSession, safeRedirect } from "./session";

const unauthorized = {
  code: 401,
  message: "The request requires valid record authorization token.",
  data: {},
};

test("no session redirects /collections to /login?redirect=%2Fcollections", async () => {
  const { router } = renderApp({ path: "/collections", auth: "none" });
  expect(await screen.findByLabelText("Email")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/login");
  expect(router.state.location.searchStr).toBe("?redirect=%2Fcollections");
});

test("a users collection token in the store counts as signed out", async () => {
  const usersAuth = {
    token: fakeToken({ id: "u1", collectionId: "pbc_users" }),
    record: { id: "u1", collectionId: "pbc_users", collectionName: "users" },
  };
  const client = createDashboardClient({ authStore: memoryStore() });
  client.authStore.save(usersAuth.token, usersAuth.record);
  expect(isSuperuserSession(client)).toBe(false);

  const { router, client: appClient } = renderApp({
    path: "/collections",
    auth: usersAuth,
  });
  expect(await screen.findByLabelText("Email")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/login");
  expect(appClient.authStore.token).toBe("");
});

test("an expired superuser token counts as signed out", () => {
  const client = createDashboardClient({ authStore: memoryStore() });
  client.authStore.save(fakeToken({ exp: 1 }), { ...SUPERUSER });
  expect(isSuperuserSession(client)).toBe(false);
  client.authStore.save(fakeToken(), { ...SUPERUSER });
  expect(isSuperuserSession(client)).toBe(true);
});

test("a 401 from any query signs out and redirects to /login", async () => {
  const server = fakeServer().on("GET", "/api/settings", unauthorized, 401);
  const { router, client, queryClient } = renderApp({
    path: "/collections",
    server,
  });
  queryClient.setQueryData(["marker"], 1);
  expect(await screen.findByLabelText("Email")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/login");
  expect(router.state.location.searchStr).toBe("?redirect=%2Fcollections");
  expect(client.authStore.token).toBe("");
  expect(queryClient.getQueryData(["marker"])).toBeUndefined();
});

test("a 401 from a mutation signs out and redirects to /login", async () => {
  const { router, client, queryClient, server } = renderApp({
    path: "/collections",
  });
  await screen.findByRole("button", { name: "Sign out" });
  server.on("DELETE", "/api/x", unauthorized, 401);
  const mutation = new MutationObserver(queryClient, {
    mutationFn: () => client.send("/api/x", { method: "DELETE" }),
  });
  await mutation.mutate().catch(() => undefined);
  expect(await screen.findByLabelText("Email")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/login");
  expect(client.authStore.token).toBe("");
});

test("redirect values must stay inside the dashboard", () => {
  expect(safeRedirect("/settings/mail?x=1")).toBe("/settings/mail?x=1");
  for (const value of [
    undefined,
    "",
    "//evil.test",
    "/\\evil.test",
    "javascript:alert(1)",
    "https://evil.test",
  ])
    expect(safeRedirect(value)).toBe("/collections");
});

test("a failed startup refresh clears the session", async () => {
  const server = fakeServer().on(
    "POST",
    "/api/collections/_superusers/auth-refresh",
    unauthorized,
    401,
  );
  const client = createDashboardClient({
    fetch: server.fetch,
    authStore: memoryStore(),
  });
  client.authStore.save(fakeToken(), { ...SUPERUSER });
  expect(await refreshSession(client)).toBe(false);
  expect(client.authStore.token).toBe("");
});

test("a successful startup refresh keeps the session", async () => {
  const server = fakeServer().on(
    "POST",
    "/api/collections/_superusers/auth-refresh",
    { token: fakeToken({ exp: 4102444801 }), record: SUPERUSER },
  );
  const client = createDashboardClient({
    fetch: server.fetch,
    authStore: memoryStore(),
  });
  client.authStore.save(fakeToken(), { ...SUPERUSER });
  expect(await refreshSession(client)).toBe(true);
  expect(client.authStore.token).toBe(fakeToken({ exp: 4102444801 }));
});

test("a startup refresh network error keeps the session", async () => {
  const client = createDashboardClient({
    fetch: () => Promise.reject(new TypeError("Failed to fetch")),
    authStore: memoryStore(),
  });
  client.authStore.save(fakeToken(), { ...SUPERUSER });
  expect(await refreshSession(client)).toBe(true);
  expect(client.authStore.token).toBe(fakeToken());
});

test("Sign out clears the store and shows /login", async () => {
  const { router, client, user } = renderApp({ path: "/collections" });
  await user.click(await screen.findByRole("button", { name: "Sign out" }));
  expect(await screen.findByLabelText("Email")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/login");
  expect(client.authStore.token).toBe("");
});
