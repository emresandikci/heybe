import type { CollectionModel } from "@heybe/client";

const VIEW_KEYWORDS = [
  "SELECT",
  "DISTINCT",
  "FROM",
  "WHERE",
  "JOIN",
  "LEFT JOIN",
  "INNER JOIN",
  "ON",
  "GROUP BY",
  "HAVING",
  "ORDER BY",
  "LIMIT",
  "AS",
  "AND",
  "OR",
  "NOT",
  "IN",
  "LIKE",
  "IS",
  "NULL",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "COUNT",
  "SUM",
  "MAX",
  "MIN",
  "AVG",
];

const INDEX_KEYWORDS = [
  "CREATE",
  "UNIQUE",
  "INDEX",
  "IF NOT EXISTS",
  "ON",
  "ASC",
  "DESC",
  "COLLATE NOCASE",
  "WHERE",
  "AND",
  "OR",
  "NOT",
  "IS",
  "NULL",
  "IN",
  "LIKE",
  "LOWER",
  "UPPER",
  "LENGTH",
  "COALESCE",
  "SUBSTR",
];

export function viewCompletions(collections: CollectionModel[]): string[] {
  const fields = collections.flatMap((c) =>
    c.fields.map((f) => [c.name, String(f.name)] as const),
  );
  return [
    ...new Set([
      ...collections.map((c) => c.name),
      ...fields.map(([table, field]) => `${table}.${field}`),
      ...fields.map(([, field]) => field),
      ...VIEW_KEYWORDS,
    ]),
  ];
}

export function indexCompletions(columns: string[]): string[] {
  return [...new Set([...columns, ...INDEX_KEYWORDS])];
}
