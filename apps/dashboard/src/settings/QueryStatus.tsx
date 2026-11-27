import type { UseQueryResult } from "@tanstack/react-query";
import { Button } from "@heybejs/ui";
import { errorMessage } from "../app/errors";

export function QueryStatus({ query }: { query: UseQueryResult }) {
  if (query.isError)
    return (
      <div
        role="alert"
        className="flex items-center gap-3 rounded-control border border-danger/40 bg-danger/10 p-3 text-sm text-danger-text"
      >
        <p>{errorMessage(query.error)}</p>
        <Button onClick={() => void query.refetch()}>Retry</Button>
      </div>
    );
  return (
    <p role="status" className="text-sm text-muted">
      Loading...
    </p>
  );
}
