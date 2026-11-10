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
import { ConfirmEmailChangePage } from "../auth/public/ConfirmEmailChangePage";
import { ConfirmPasswordResetPage } from "../auth/public/ConfirmPasswordResetPage";
import { ConfirmVerificationPage } from "../auth/public/ConfirmVerificationPage";
import { OAuth2RedirectPage } from "../auth/public/OAuth2RedirectPage";
import {
  CollectionPage,
  CollectionsIndex,
  CollectionsLayout,
} from "../collections/CollectionsLayout";
import { validateRecordsSearch } from "../records/RecordsPage";
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

const publicRoutes = [
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/auth/confirm-verification/$token",
    component: ConfirmVerificationPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/auth/confirm-password-reset/$token",
    component: ConfirmPasswordResetPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/auth/confirm-email-change/$token",
    component: ConfirmEmailChangePage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/auth/oauth2-redirect-success",
    component: () => <OAuth2RedirectPage success />,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/auth/oauth2-redirect-failure",
    component: () => <OAuth2RedirectPage success={false} />,
  }),
];

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
  component: CollectionsLayout,
});

const collectionsIndexRoute = createRoute({
  getParentRoute: () => collectionsRoute,
  path: "/",
  component: CollectionsIndex,
});

const collectionRoute = createRoute({
  getParentRoute: () => collectionsRoute,
  path: "$collectionId",
  validateSearch: validateRecordsSearch,
  component: CollectionPage,
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
  ...publicRoutes,
  shellRoute.addChildren([
    indexRoute,
    collectionsRoute.addChildren([collectionsIndexRoute, collectionRoute]),
    logsRoute,
    settingsRoute,
  ]),
]);
