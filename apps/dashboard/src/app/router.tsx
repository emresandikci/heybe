import {
  createHashHistory,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import type { AppContext } from "./context";
import { routeTree } from "./routes";

export function createAppRouter(ctx: AppContext, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: ctx,
    history: history ?? createHashHistory(),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
