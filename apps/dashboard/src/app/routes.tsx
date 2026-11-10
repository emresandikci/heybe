import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  redirect,
} from "@tanstack/react-router";
import { guestOnly, requireSuperuser } from "../auth/session";
import { InstallerPage } from "../auth/InstallerPage";
import { LoginPage } from "../auth/LoginPage";
import { RequestResetPage } from "../auth/RequestResetPage";
import { Shell } from "../layout/Shell";
import { EmptyState } from "../ui/EmptyState";
import type { AppContext } from "./context";

export const rootRoute = createRootRouteWithContext<AppContext>()({
  component: Outlet,
});

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  beforeLoad: requireSuperuser,
  component: Shell,
});

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
  beforeLoad: guestOnly,
  component: LoginPage,
});

const requestResetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/request-password-reset",
  beforeLoad: guestOnly,
  component: RequestResetPage,
});

export const installerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pbinstall/$token",
  beforeLoad: guestOnly,
  component: InstallerPage,
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
  loginRoute,
  requestResetRoute,
  installerRoute,
  shellRoute.addChildren([
    indexRoute,
    collectionsRoute,
    logsRoute,
    settingsRoute,
  ]),
]);
