const OPERATOR_CHARS = ["=", "~", ">", "<", "(", ")", "&", "|"];
export function normalizeSearchFilter(text: string, fields: string[]): string {
  const term = text.trim();
  if (!term || fields.length === 0) return term;
  if (OPERATOR_CHARS.some((op) => term.includes(op))) return term;
  const plain =
    Number.isNaN(Number(term)) && term !== "true" && term !== "false"
      ? term.replace(/^["'`]|["'`]$/g, "")
      : term;
  const quoted = `"${plain.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return fields.map((name) => `${name}?~${quoted}`).join("||");
}
