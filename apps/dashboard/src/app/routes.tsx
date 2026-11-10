import type { ReactNode } from "react";
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
import { ApplicationPage } from "../settings/ApplicationPage";
import { LogsPage, validateLogsSearch } from "../logs/LogsPage";
import { SqlPage } from "../settings/SqlPage";
import { BackupsPage } from "../settings/BackupsPage";
import { CronsPage } from "../settings/CronsPage";
import { MailPage } from "../settings/MailPage";
import { StoragePage } from "../settings/StoragePage";
import { SettingsLayout } from "../settings/SettingsLayout";
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
  validateSearch: validateLogsSearch,
  component: LogsPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/settings",
  component: SettingsLayout,
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  component: ApplicationPage,
});

const settingsPage = <P extends string>(
  path: P,
  title: string,
  component: () => ReactNode = placeholder(title),
) =>
  createRoute({
    getParentRoute: () => settingsRoute,
    path,
    component,
  });

const settingsPages = [
  settingsPage("mail", "Mail", MailPage),
  settingsPage("storage", "File storage", StoragePage),
  settingsPage("backups", "Backups", BackupsPage),
  settingsPage("crons", "Crons", CronsPage),
  settingsPage("export-collections", "Export collections"),
  settingsPage("import-collections", "Import collections"),
  settingsPage("sql", "SQL", SqlPage),
];

export const routeTree = rootRoute.addChildren([
  loginRoute,
  requestResetRoute,
  installerRoute,
  ...publicRoutes,
  shellRoute.addChildren([
    indexRoute,
    collectionsRoute.addChildren([collectionsIndexRoute, collectionRoute]),
    logsRoute,
    settingsRoute.addChildren([settingsIndexRoute, ...settingsPages]),
  ]),
]);
