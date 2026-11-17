import {
  createHashHistory,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { signOutOnUnauthorized } from "../auth/session";
import { EmptyState } from "@heybe/ui";
import type { AppContext } from "./context";
import { routeTree } from "./routes";

export function createAppRouter(ctx: AppContext, history?: RouterHistory) {
  const router = createRouter({
    routeTree,
    context: ctx,
    history: history ?? createHashHistory(),
    defaultNotFoundComponent: () => <EmptyState title="Page not found" />,
  });
  signOutOnUnauthorized(ctx, router);
  return router;
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
