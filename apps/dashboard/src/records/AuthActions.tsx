import type { CollectionModel } from "@heybe/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useClient } from "../app/context";
import { errorMessage } from "../app/errors";
import { useToast, type MenuItem } from "@heybe/ui";
import { ImpersonateDialog } from "./ImpersonateDialog";

export function useAuthActions(
  collection: CollectionModel,
  record: { id: string; email?: unknown; verified?: unknown },
) {
  const client = useClient();
  const toast = useToast();
  const [impersonating, setImpersonating] = useState(false);
  const auth = client.auth(collection.name);
  const email = String(record.email ?? "");
  const passwordAuth = collection.passwordAuth as
    { enabled?: boolean } | undefined;

  const send = useMutation({
    mutationFn: (kind: "verification" | "reset") =>
      kind === "verification"
        ? auth.requestVerification(email)
        : auth.requestPasswordReset(email),
    onSuccess: (_, kind) =>
      toast.success(
        kind === "verification"
          ? "Verification email sent."
          : "Password reset email sent.",
      ),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const items: MenuItem[] = [];
  if (email && !record.verified)
    items.push({ key: "verification", label: "Send verification email" });
  if (email && passwordAuth?.enabled !== false)
    items.push({ key: "reset", label: "Send password reset email" });
  items.push({ key: "impersonate", label: "Impersonate" });

  const run = (key: string) => {
    if (key === "verification" || key === "reset") send.mutate(key);
    else if (key === "impersonate") setImpersonating(true);
  };

  const dialog = impersonating ? (
    <ImpersonateDialog
      collection={collection}
      recordId={record.id}
      label={email || record.id}
      onClose={() => setImpersonating(false)}
    />
  ) : null;

  return { items, run, dialog };
}
