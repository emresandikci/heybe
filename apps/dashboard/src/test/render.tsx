import { memoryStore, type HeybeClient } from "@heybe/client";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, type RenderResult } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { QueryClient } from "@tanstack/react-query";
import { createDashboardClient } from "../app/client";
import { Providers, createQueryClient } from "../app/context";
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
  auth?: "superuser" | "none";
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
  ];
  for (const [method, path, reply] of defaults) {
    if (!server.has(method, path)) server.on(method, path, reply);
  }

  const authStore = memoryStore();
  if ((opts.auth ?? "superuser") === "superuser")
    authStore.save(fakeToken(), { ...SUPERUSER });
  const client = createDashboardClient({ fetch: server.fetch, authStore });
  const queryClient = createQueryClient();
  const router = createAppRouter(
    { client, queryClient },
    createMemoryHistory({ initialEntries: [opts.path] }),
  );
  const result = render(
    <Providers client={client} queryClient={queryClient}>
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
