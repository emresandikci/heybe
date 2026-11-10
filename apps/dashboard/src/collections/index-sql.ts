export const IDENT = '`[^`]*`|"[^"]*"|\\[[^\\]]*\\]|\\w+';

const HEAD = new RegExp(
  `^\\s*CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:(?:${IDENT})\\.)?(${IDENT})\\s+ON\\s+(${IDENT})\\s*\\(`,
  "i",
);
const FIRST_IDENT = new RegExp(`^\\s*(${IDENT})`);
const ONLY_IDENT = new RegExp(`^\\s*(?:${IDENT})\\s*$`);

export const quote = (name: string) => "`" + name.replaceAll("`", "``") + "`";
export const unquote = (ident: string) =>
  /^[`"[]/.test(ident) ? ident.slice(1, -1) : ident;

export function randomIndexName(): string {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return "idx_" + Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

export function buildIndex(o: {
  table: string;
  columns: string[];
  unique: boolean;
  name?: string;
}): string {
  const name = quote(o.name ?? randomIndexName());
  const columns = o.columns.map(quote).join(", ");
  return `CREATE ${o.unique ? "UNIQUE " : ""}INDEX ${name} ON ${quote(o.table)} (${columns})`;
}

function splitTopLevel(sql: string): { parts: string[]; end: number } | null {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) {
        parts.push(sql.slice(start, i));
        return { parts, end: i + 1 };
      }
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(sql.slice(start, i));
      start = i + 1;
    }
  }
  return null;
}

// simple: plain column names and nothing after the column list, so the checkboxes can rebuild it without losing SQL.
export function parseIndex(sql: string): {
  name: string;
  unique: boolean;
  table: string;
  columns: string[];
  simple: boolean;
} | null {
  const head = HEAD.exec(sql);
  if (!head) return null;
  const body = sql.slice(head[0].length);
  const split = splitTopLevel(body);
  const columns = split?.parts.map((p) => FIRST_IDENT.exec(p)?.[1]);
  if (!split || !columns || columns.some((c) => !c)) return null;
  return {
    name: unquote(head[2]!),
    unique: !!head[1],
    table: unquote(head[3]!),
    columns: columns.map((c) => unquote(c!)),
    simple:
      split.parts.every((p) => ONLY_IDENT.test(p)) &&
      /^\s*;?\s*$/.test(body.slice(split.end)),
  };
}
