import { HeybeError, tokenExpired, type HeybeClient } from "@heybe/client";
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

export function signOut(ctx: AppContext): void {
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
};

export function safeRedirect(value: string | undefined): string {
  return value && /^\/(?![/\\])/.test(value) ? value : "/collections";
}

export function signOutOnUnauthorized(
  ctx: AppContext,
  router: AppRouter,
): void {
  const onError = (error: unknown) => {
    if (!(error instanceof HeybeError) || error.status !== 401) return;
    if (!ctx.client.authStore.token) return;
    const href = router.state.location.href;
    signOut(ctx);
    void router.navigate({ to: "/login", search: { redirect: href } });
  };
  ctx.queryClient.getQueryCache().subscribe((event) => {
    if (event.type === "updated" && event.action.type === "error")
      onError(event.action.error);
  });
  ctx.queryClient.getMutationCache().subscribe((event) => {
    if (event.type === "updated" && event.action.type === "error")
      onError(event.action.error);
  });
}
