import { ApiError } from "./errors";
import type { Form } from "./multipart";

type Kind = "string" | "strings" | "bool" | "int" | "rule" | "interface";

// A Go struct field PB binds from form values: the form key, its kind and the JSON paths it sets.
// PB keeps only the last struct tag as the key prefix, so one key can set several fields.
export type FormField = [key: string, kind: Kind, ...paths: string[]];

export class FormBindError extends Error {}

const GO_TRUE = ["1", "t", "T", "TRUE", "true", "True"];
const GO_FALSE = ["", "0", "f", "F", "FALSE", "false", "False"];

function parseBool(v: string): boolean {
  if (GO_TRUE.includes(v)) return true;
  if (GO_FALSE.includes(v)) return false;
  throw new FormBindError();
}

// Go strconv underscoreOK: underscores only between digits or after a base prefix
function underscoreOK(s: string): boolean {
  let saw = "^";
  let i = 0;
  const prefix = s[0] === "0" ? s[1]?.toLowerCase() : undefined;
  const hex = prefix === "x";
  if (s.length >= 2 && (prefix === "b" || prefix === "o" || hex)) {
    i = 2;
    saw = "0";
  }
  for (; i < s.length; i++) {
    const c = s[i].toLowerCase();
    if ((c >= "0" && c <= "9") || (hex && c >= "a" && c <= "f")) saw = "0";
    else if (c === "_") {
      if (saw !== "0") return false;
      saw = "_";
    } else {
      if (saw === "_") return false;
      saw = "!";
    }
  }
  return saw !== "_";
}

const PREFIXES: Record<string, number> = { b: 2, o: 8, x: 16 };

// Go strconv.ParseInt(v, 0, 64), with PB's "" as 0
function parseInt64(v: string): number {
  if (v === "") return 0;
  let s = v;
  const negative = s[0] === "-";
  if (negative || s[0] === "+") s = s.slice(1);
  if (s === "" || !underscoreOK(s)) throw new FormBindError();
  let radix = 10;
  if (s[0] === "0") {
    const prefixed = PREFIXES[s.length >= 3 ? s[1].toLowerCase() : ""];
    radix = prefixed ?? 8;
    s = s.slice(prefixed ? 2 : 1);
  }
  let n = 0n;
  for (const c of s) {
    if (c === "_") continue;
    const digit = parseInt(c, 36);
    if (Number.isNaN(digit) || digit >= radix) throw new FormBindError();
    n = n * BigInt(radix) + BigInt(digit);
  }
  if (negative) n = -n;
  if (n >= 2n ** 63n || n < -(2n ** 63n)) throw new FormBindError();
  return Number(n);
}

function getPath(o: Record<string, unknown>, path: string): unknown {
  let cur: unknown = o;
  for (const key of path.split("."))
    cur = (cur as Record<string, unknown>)?.[key];
  return cur;
}

function setPath(o: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let cur = o;
  for (const key of keys.slice(0, -1))
    cur = (cur[key] ??= {}) as Record<string, unknown>;
  cur[keys.at(-1)!] = value;
}

// Go Request.Form: the body values, then the URL query values.
export function formValues(
  form: Form,
  query: URLSearchParams,
): Map<string, string[]> {
  const out = new Map([...form.values].map(([k, v]) => [k, [...v]]));
  for (const [k, v] of query) {
    const list = out.get(k);
    if (list) list.push(v);
    else out.set(k, [v]);
  }
  return out;
}

// Port of PB unmarshalInStructValue as a JSON patch for `current`. Rules are Go *string fields that
// PB allocates while walking the struct, so a null rule becomes "" whenever there are form values.
export function bindForm(
  values: Map<string, string[]>,
  fields: FormField[],
  current: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (values.size === 0) return out;
  for (const [key, kind, ...paths] of fields) {
    const list = values.get(key);
    if (!list) {
      if (kind === "rule")
        for (const p of paths)
          if (getPath(current, p) == null) setPath(out, p, "");
      continue;
    }
    // PB sets the form string into a Go interface it cannot hold and panics
    if (kind === "interface") throw new ApiError(500, "");
    const value =
      kind === "strings"
        ? list
        : kind === "bool"
          ? parseBool(list[0])
          : kind === "int"
            ? parseInt64(list[0])
            : list[0];
    for (const p of paths) setPath(out, p, value);
  }
  return out;
}

// The `@jsonPayload` values PB unmarshals into the struct after the form values.
export function jsonPayloads(values: Map<string, string[]>): unknown[] {
  return (values.get("@jsonPayload") ?? []).map((raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      throw new FormBindError();
    }
  });
}
