import type { CollectionModel } from "@heybe/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useClient } from "../app/context";
import { errorMessage } from "../app/errors";
import { Button, useToast } from "@heybe/ui";
import { ImpersonateDialog } from "./ImpersonateDialog";

export function AuthActions({
  collection,
  record,
}: {
  collection: CollectionModel;
  record: { id: string; email?: unknown; verified?: unknown };
}) {
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

  return (
    <>
      {email && !record.verified && (
        <Button
          disabled={send.isPending}
          onClick={() => send.mutate("verification")}
        >
          Send verification email
        </Button>
      )}
      {email && passwordAuth?.enabled !== false && (
        <Button disabled={send.isPending} onClick={() => send.mutate("reset")}>
          Send password reset email
        </Button>
      )}
      <Button onClick={() => setImpersonating(true)}>Impersonate</Button>
      {impersonating && (
        <ImpersonateDialog
          collection={collection}
          recordId={record.id}
          label={email || record.id}
          onClose={() => setImpersonating(false)}
        />
      )}
    </>
  );
}
