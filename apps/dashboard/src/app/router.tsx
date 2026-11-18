import {
  createHashHistory,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { signOutOnUnauthorized } from "../auth/session";
import { NotFound } from "../layout/NotFound";
import type { AppContext } from "./context";
import { routeTree } from "./routes";

export function createAppRouter(ctx: AppContext, history?: RouterHistory) {
  const router = createRouter({
    routeTree,
    context: ctx,
    history: history ?? createHashHistory(),
    defaultNotFoundComponent: NotFound,
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
