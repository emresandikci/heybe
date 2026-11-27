import type { CollectionModel } from "@heybejs/client";
import type { CodeSuggest, CodeSuggestion } from "@heybejs/ui";

type SchemaField = {
  name: string;
  type: string;
  hidden?: boolean;
  collectionId?: string;
};

export interface FilterSchema {
  collectionId?: string;
  fields: SchemaField[];
  collections?: CollectionModel[];
  request?: { body: boolean };
}

type Option = CodeSuggestion["options"][number];
type Token = { kind: "word" | "op" | "logic" | "open" | "close" | "comma" };
type State = "operand" | "operator" | "logic" | "arg";

const OPERATORS = ["=", "!=", ">", ">=", "<", "<=", "~", "!~"];
const MACROS = [
  "@now",
  "@yesterday",
  "@tomorrow",
  "@second",
  "@minute",
  "@hour",
  "@day",
  "@month",
  "@weekday",
  "@year",
  "@todayStart",
  "@todayEnd",
  "@monthStart",
  "@monthEnd",
  "@yearStart",
  "@yearEnd",
];
const AUTH_FIELDS = ["id", "collectionId", "collectionName"];
const WORD = /[\w@.:+-]+$/;
const OPERATOR_TAIL = /[?!=<>~]+$/;
const LOGIC_TAIL = /[&|]+$/;
const TOKEN =
  /\s+|(["'`])(?:\\.|(?!\1)[^\\])*(?:\1|$)|&&|\|\||\??(?:!=|!~|>=|<=|=|>|<|~)|[\w@.:+-]+|[(),]|[^]/y;

export const logsSchema: FilterSchema = {
  fields: [
    { name: "id", type: "text" },
    { name: "created", type: "autodate" },
    { name: "level", type: "number" },
    { name: "message", type: "text" },
    { name: "data.status", type: "number" },
    { name: "data.method", type: "text" },
    { name: "data.url", type: "text" },
    { name: "data.auth", type: "text" },
    { name: "data.userIP", type: "text" },
    { name: "data.execTime", type: "number" },
  ],
};

const option = (label: string, detail: string, type = "variable"): Option => ({
  label,
  detail,
  type,
});

// Returns null while the text ends inside a string.
function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (TOKEN.lastIndex < text.length && (m = TOKEN.exec(text))) {
    const t = m[0];
    if (/^\s/.test(t)) continue;
    if (m[1]) {
      if (t.length < 2 || !t.endsWith(m[1])) return null;
      tokens.push({ kind: "word" });
    } else if (t === "&&" || t === "||") tokens.push({ kind: "logic" });
    else if (t === "(") tokens.push({ kind: "open" });
    else if (t === ")") tokens.push({ kind: "close" });
    else if (t === ",") tokens.push({ kind: "comma" });
    else if (/^\??[!=<>~]/.test(t)) tokens.push({ kind: "op" });
    else if (/^[\w@.:+-]/.test(t)) tokens.push({ kind: "word" });
  }
  return tokens;
}

function stateAt(tokens: Token[]): { state: State; depth: number } {
  const stack: { fn: boolean; right: boolean }[] = [];
  let state: State = "operand";
  let right = false;
  const complete = (isRight: boolean) => {
    if (stack.at(-1)?.fn) state = "arg";
    else state = isRight ? "logic" : "operator";
  };
  tokens.forEach((t, i) => {
    if (t.kind === "word") {
      if (tokens[i + 1]?.kind !== "open") complete(right);
    } else if (t.kind === "op") {
      state = "operand";
      right = true;
    } else if (t.kind === "logic") {
      state = "operand";
      right = false;
    } else if (t.kind === "open") {
      const fn = tokens[i - 1]?.kind === "word";
      stack.push({ fn, right });
      state = "operand";
      right = fn;
    } else if (t.kind === "close") {
      const closed = stack.pop();
      if (closed?.fn) {
        right = closed.right;
        complete(closed.right);
      } else state = "logic";
    } else {
      state = "operand";
      right = true;
    }
  });
  return { state, depth: stack.length };
}

const visible = (f: SchemaField, allowHidden: boolean) =>
  f.type !== "password" && (allowHidden || !f.hidden);

function operands(schema: FilterSchema, word: string): Option[] {
  const rules = !!schema.request;
  const collections = schema.collections ?? [];
  const nested = (prefix: string, c: CollectionModel): Option[] =>
    (c.fields as SchemaField[])
      .filter((f) => visible(f, false))
      .map((f) => option(`${prefix}.${f.name}`, f.type));

  const list: Option[] = [];
  for (const f of schema.fields) {
    if (!visible(f, rules)) continue;
    list.push(option(f.name, f.type));
    if (f.type !== "relation") continue;
    const target = collections.find((c) => c.id === f.collectionId);
    if (target) list.push(...nested(f.name, target));
  }
  for (const c of collections)
    for (const f of c.fields as SchemaField[]) {
      if (f.type !== "relation" || f.collectionId !== schema.collectionId)
        continue;
      const name = `${c.name}_via_${f.name}`;
      list.push(option(name, "back-relation"), ...nested(name, c));
    }

  if (rules) {
    list.push(
      option("@request.method", "request"),
      option("@request.context", "request"),
      option("@request.query.", "request"),
      option("@request.headers.", "request"),
    );
    for (const [name, type] of authFields(collections))
      list.push(option(`@request.auth.${name}`, type));
    if (schema.request!.body)
      for (const f of schema.fields)
        list.push(option(`@request.body.${f.name}`, f.type));

    const named = /^@collection\.(\w+)(?::\w+)?\./.exec(word);
    const target = named && collections.find((c) => c.name === named[1]);
    if (named && target) list.push(...nested(named[0].slice(0, -1), target));
    else
      for (const c of collections)
        list.push(option(`@collection.${c.name}.`, "collection"));
  }

  list.push(
    ...MACROS.map((m) => option(m, "macro")),
    option("geoDistance(", "function", "function"),
    option("strftime(", "function", "function"),
    option("true", "literal", "keyword"),
    option("false", "literal", "keyword"),
    option("null", "literal", "keyword"),
    option('""', "literal", "keyword"),
  );
  return list;
}

function authFields(collections: CollectionModel[]) {
  const auth = new Map<string, string>(AUTH_FIELDS.map((n) => [n, "text"]));
  for (const c of collections)
    if (c.type === "auth")
      for (const f of c.fields as SchemaField[])
        if (visible(f, false)) auth.set(f.name, f.type);
  return auth;
}

const find = (fields: SchemaField[], name: string) =>
  fields.find((f) => f.name === name)?.type;

function typeOf(schema: FilterSchema, path: string): string | undefined {
  const collections = schema.collections ?? [];
  const byName = (name: string) => collections.find((c) => c.name === name);
  const direct = find(schema.fields, path);
  if (direct) return direct;
  if (path.startsWith("@request.body."))
    return find(schema.fields, path.slice("@request.body.".length));
  if (path.startsWith("@request.auth."))
    return authFields(collections).get(path.slice("@request.auth.".length));
  const named = /^@collection\.(\w+)(?::\w+)?\.(.+)$/.exec(path);
  let fields = schema.fields;
  let rest = path;
  if (named) {
    const target = byName(named[1]!);
    if (!target) return undefined;
    fields = target.fields as SchemaField[];
    rest = named[2]!;
  }
  const segments = rest.split(".");
  for (const [i, name] of segments.entries()) {
    if (i === segments.length - 1) return find(fields, name);
    const back = /^(\w+)_via_\w+$/.exec(name);
    const relation = fields.find((f) => f.name === name);
    const target = back
      ? byName(back[1]!)
      : collections.find((c) => c.id === relation?.collectionId);
    if (!target) return undefined;
    fields = target.fields as SchemaField[];
  }
  return undefined;
}

const MULTI_VALUERS = ["select", "relation", "file"];
const PLAIN_AUTH = [...AUTH_FIELDS, "email", "emailVisibility", "verified"];

function modifiers(schema: FilterSchema, word: string): Option[] {
  const path = word.slice(0, word.lastIndexOf(":"));
  const type = typeOf(schema, path);
  const multi = type !== undefined && MULTI_VALUERS.includes(type);
  const typed = multi ? ["length", "each", "lower"] : ["lower"];
  let names = typed;
  if (path.startsWith("@request.body.")) names = ["isset", "changed", ...typed];
  else if (path.startsWith("@request.auth.")) {
    if (PLAIN_AUTH.includes(path.slice("@request.auth.".length)))
      names = ["isset", "lower"];
  } else if (path.startsWith("@request.")) names = ["isset", "lower"];
  return names.map((n) => option(n, "modifier", "keyword"));
}

const operatorOptions = () => [
  ...OPERATORS.map((o) => option(o, "operator", "keyword")),
  ...OPERATORS.map((o) => option(`?${o}`, "operator", "keyword")),
];
const logicOptions = () => [
  option("&&", "logic", "keyword"),
  option("||", "logic", "keyword"),
];

export function createSuggest(schema: FilterSchema): CodeSuggest {
  return (text, pos) => {
    const before = text.slice(0, pos);
    if (!tokenize(before)) return null;
    const tail =
      WORD.exec(before) ??
      OPERATOR_TAIL.exec(before) ??
      LOGIC_TAIL.exec(before);
    const start = tail?.index ?? pos;
    const { state, depth } = stateAt(tokenize(before.slice(0, start))!);
    const result = (from: number, options: Option[]) => ({ from, options });
    const word = tail && WORD.test(tail[0]) ? tail[0] : "";

    if (word) {
      if (state !== "operand") return null;
      const path = word.replace(/^@collection\.\w+(?::\w+)?\./, "");
      if (path.includes(":") && !/^@collection\.\w+:\w*$/.test(word))
        return result(
          start + word.lastIndexOf(":") + 1,
          modifiers(schema, word),
        );
      return result(start, operands(schema, word));
    }
    if (tail && OPERATOR_TAIL.test(tail[0]))
      return state === "operator" ? result(start, operatorOptions()) : null;
    if (tail && LOGIC_TAIL.test(tail[0]))
      return state === "logic" ? result(start, logicOptions()) : null;

    if (state === "operand") return result(pos, operands(schema, ""));
    if (state === "operator") return result(pos, operatorOptions());
    const close = option(")", "logic", "keyword");
    if (state === "arg")
      return result(pos, [option(",", "separator", "keyword"), close]);
    return result(pos, [...logicOptions(), ...(depth ? [close] : [])]);
  };
}
