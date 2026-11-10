import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  redirect,
} from "@tanstack/react-router";
import { Shell } from "../layout/Shell";
import { EmptyState } from "../ui/EmptyState";
import type { AppContext } from "./context";

export const rootRoute = createRootRouteWithContext<AppContext>()({
  component: Outlet,
});

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: Shell,
});

const indexRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/collections" });
  },
});

const placeholder = (title: string) => () => <EmptyState title={title} />;

const collectionsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/collections",
  component: placeholder("Collections"),
});

const logsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/logs",
  component: placeholder("Logs"),
});

const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/settings",
  component: placeholder("Settings"),
});

export const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([
    indexRoute,
    collectionsRoute,
    logsRoute,
    settingsRoute,
  ]),
]);
