import { useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useClient } from "../../app/context";
import { errorMessage } from "../../app/errors";
import { AuthCard } from "../AuthCard";
import { collectionIdOf } from "./collection";
import { InvalidLink } from "./InvalidLink";

const TITLE = "Verify email";

export function ConfirmVerificationPage() {
  const { token } = useParams({ from: "/auth/confirm-verification/$token" });
  const collectionId = collectionIdOf(token);
  if (!collectionId) return <InvalidLink title={TITLE} />;
  return <Verify token={token} collectionId={collectionId} />;
}

function Verify({
  token,
  collectionId,
}: {
  token: string;
  collectionId: string;
}) {
  const client = useClient();
  const [result, setResult] = useState<{ error?: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    client
      .auth(collectionId)
      .confirmVerification(token, { signal: controller.signal })
      .then(
        () => setResult({}),
        (err) => {
          if (!controller.signal.aborted)
            setResult({ error: errorMessage(err) });
        },
      );
    return () => controller.abort();
  }, [client, collectionId, token]);

  return (
    <AuthCard title={TITLE}>
      {result === null ? (
        <p role="status">Verifying...</p>
      ) : result.error ? (
        <p role="alert">{result.error}</p>
      ) : (
        <p role="status">Your email address is verified.</p>
      )}
    </AuthCard>
  );
}
