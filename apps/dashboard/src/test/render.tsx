import { memoryStore, type AuthRecord, type HeybeClient } from "@heybe/client";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, type RenderResult } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { QueryClient } from "@tanstack/react-query";
import { createDashboardClient } from "../app/client";
import { Providers, createQueryClient } from "../app/context";
import {
  emptyExtensionRegistry,
  type ExtensionRegistry,
} from "../app/extensions";
import { createAppRouter, type AppRouter } from "../app/router";
import { fakeServer, type FakeServer, type Reply } from "./fake-server";
import { collectionsFixture, settingsFixture } from "./fixtures";

export const SUPERUSER = {
  id: "su1",
  collectionId: "pbc_3142635823",
  collectionName: "_superusers",
  email: "admin@example.com",
} as const;

const b64 = (value: object) =>
  btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

export function fakeToken(claims: Record<string, unknown> = {}): string {
  const payload = {
    id: "su1",
    type: "auth",
    collectionId: "pbc_3142635823",
    exp: 4102444800,
    ...claims,
  };
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.signature`;
}

export function renderApp(opts: {
  path: string;
  server?: FakeServer;
  auth?: "superuser" | "none" | { token: string; record: AuthRecord };
  extensions?: ExtensionRegistry;
}): {
  server: FakeServer;
  client: HeybeClient;
  router: AppRouter;
  user: UserEvent;
  queryClient: QueryClient;
  result: RenderResult;
} {
  const server = opts.server ?? fakeServer();
  const defaults: [string, string, Reply][] = [
    [
      "POST",
      "/api/collections/_superusers/auth-refresh",
      () => ({ token: fakeToken(), record: SUPERUSER }),
    ],
    [
      "GET",
      "/api/collections",
      () => ({
        page: 1,
        perPage: 1000,
        totalItems: collectionsFixture.length,
        totalPages: 1,
        items: collectionsFixture,
      }),
    ],
    ["GET", "/api/settings", () => settingsFixture],
    [
      "GET",
      "/api/collections/:c/records",
      () => ({ page: 1, perPage: 40, totalItems: 0, totalPages: 1, items: [] }),
    ],
    [
      "GET",
      "/api/collections/_superusers/auth-methods",
      () => ({
        password: { enabled: true, identityFields: ["email"] },
        oauth2: { enabled: false, providers: [] },
        mfa: { enabled: false, duration: 0 },
        otp: { enabled: false, duration: 0 },
      }),
    ],
  ];
  for (const [method, path, reply] of defaults) {
    if (!server.has(method, path)) server.fallback(method, path, reply);
  }

  const authStore = memoryStore();
  const auth = opts.auth ?? "superuser";
  if (auth === "superuser") authStore.save(fakeToken(), { ...SUPERUSER });
  else if (auth !== "none") authStore.save(auth.token, auth.record);
  const client = createDashboardClient({ fetch: server.fetch, authStore });
  const queryClient = createQueryClient();
  const extensions = opts.extensions ?? emptyExtensionRegistry();
  const router = createAppRouter(
    { client, queryClient, extensions },
    createMemoryHistory({ initialEntries: [opts.path] }),
  );
  const result = render(
    <Providers
      client={client}
      queryClient={queryClient}
      extensions={extensions}
    >
      <RouterProvider router={router} />
    </Providers>,
  );
  return {
    server,
    client,
    router,
    queryClient,
    result,
    user: userEvent.setup({ delay: null }),
  };
}
