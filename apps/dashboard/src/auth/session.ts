import { HeybeError, tokenExpired, type HeybeClient } from "@heybejs/client";
import { onUnauthorized } from "../app/client";
import { redirect, type ParsedLocation } from "@tanstack/react-router";
import type { AppContext } from "../app/context";
import type { AppRouter } from "../app/router";

export function isSuperuserSession(client: HeybeClient): boolean {
  const { token, record } = client.authStore;
  return (
    !!token &&
    !tokenExpired(token, Date.now()) &&
    record?.collectionName === "_superusers"
  );
}

export async function refreshSession(client: HeybeClient): Promise<boolean> {
  try {
    await client.auth("_superusers").refresh();
    return true;
  } catch (err) {
    if (err instanceof HeybeError && [401, 403, 404].includes(err.status)) {
      client.authStore.clear();
      return false;
    }
    return true;
  }
}

export function signOut(ctx: Pick<AppContext, "client" | "queryClient">): void {
  ctx.client.authStore.clear();
  ctx.queryClient.clear();
}

export const requireSuperuser = ({
  context,
  location,
}: {
  context: AppContext;
  location: ParsedLocation;
}) => {
  if (isSuperuserSession(context.client)) return;
  signOut(context);
  throw redirect({ to: "/login", search: { redirect: location.href } });
};

export const guestOnly = ({ context }: { context: AppContext }) => {
  if (isSuperuserSession(context.client)) throw redirect({ to: "/" });
  // a stale token would otherwise go out with sign-in requests
  context.client.authStore.clear();
};

export function safeRedirect(value: string | undefined): string {
  return value && /^\/(?![/\\])/.test(value) ? value : "/collections";
}

export function signOutOnUnauthorized(
  ctx: AppContext,
  router: AppRouter,
): void {
  onUnauthorized(ctx.client, () => {
    const href = router.state.location.href;
    signOut(ctx);
    void router.navigate({ to: "/login", search: { redirect: href } });
  });
}
