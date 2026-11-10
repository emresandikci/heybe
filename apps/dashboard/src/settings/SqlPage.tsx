import type { SqlResult } from "@heybe/client";
import { useState } from "react";
import { useClient } from "../app/context";
import { errorMessage } from "../app/errors";
import { Button } from "../ui/Button";
import { CodeArea } from "../ui/CodeArea";
import { Table, Td, Th } from "../ui/Table";

export function SqlPage() {
  const client = useClient();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState("");

  const run = async () => {
    if (!query.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      setResult(await client.sql.run(query));
    } catch (err) {
      setResult(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
        Queries run directly on the database. They skip API rules, hooks and
        migrations.
      </p>
      <CodeArea
        label="SQL query"
        rows={8}
        value={query}
        onChange={setQuery}
        onRun={() => void run()}
      />
      <Button
        className="self-start"
        variant="primary"
        loading={busy}
        onClick={() => void run()}
      >
        Run
      </Button>
      {error && (
        <div
          role="alert"
          className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </div>
      )}
      {result && (
        <>
          <p className="text-sm">
            {result.rows.length} rows, {result.affectedRows} affected,{" "}
            {result.execTime} ms
          </p>
          {result.columns.length > 0 && (
            <Table caption="Result">
              <thead>
                <tr>
                  {result.columns.map((c, i) => (
                    <Th key={i}>{c.name}</Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <Td key={j}>{cell === null ? "NULL" : cell}</Td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </>
      )}
    </div>
  );
}
