import { filterSyntaxError, readText } from "./fexpr";
import type { Expr, Op, Operand } from "@heybe/query";

export class FilterError extends Error {}

type Token =
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "word"; value: string }
  | { type: "op"; value: Op }
  | { type: "and" | "or" | "(" | ")" | "," };

const OPS: Op[] = [
  "?!=",
  "?>=",
  "?<=",
  "?!~",
  "?=",
  "?>",
  "?<",
  "?~",
  "!=",
  "!~",
  ">=",
  "<=",
  "=",
  ">",
  "<",
  "~",
];

const NUMBER = /^[+-]?\d+(\.\d+)?(?![\w.:@])/;
const WORD = /^[A-Za-z_@#][\w.:@]*/;
const FIELD = new RegExp(`${WORD.source}$`);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const char = input[i]!;
    const rest = input.slice(i);
    if (/\s/.test(char)) {
      i++;
    } else if (rest.startsWith("//")) {
      const end = input.indexOf("\n", i);
      i = end === -1 ? input.length : end + 1;
    } else if (char === '"' || char === "'") {
      const [value, next] = readText(input, i);
      tokens.push({ type: "string", value });
      i = next;
    } else if (rest.startsWith("&&")) {
      tokens.push({ type: "and" });
      i += 2;
    } else if (rest.startsWith("||")) {
      tokens.push({ type: "or" });
      i += 2;
    } else if (char === "(" || char === ")" || char === ",") {
      tokens.push({ type: char });
      i++;
    } else {
      const op = OPS.find((candidate) => rest.startsWith(candidate));
      const number = NUMBER.exec(rest);
      const word = WORD.exec(rest);
      if (op) {
        tokens.push({ type: "op", value: op });
        i += op.length;
      } else if (number) {
        tokens.push({ type: "number", value: Number(number[0]) });
        i += number[0].length;
      } else if (word) {
        tokens.push({ type: "word", value: word[0] });
        i += word[0].length;
      } else {
        throw new FilterError(`Invalid filter: unexpected character "${char}"`);
      }
    }
  }
  return tokens;
}

const LITERALS = new Map<string, boolean | null>([
  ["true", true],
  ["false", false],
  ["null", null],
]);

const MAX_DEPTH = 64;

function isMacro(word: string) {
  return (
    word.startsWith("@") &&
    !word.includes(".") &&
    word !== "@rowid" &&
    word !== "@random"
  );
}

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Expr {
    const expr = this.parseGroup("or");
    if (this.pos < this.tokens.length) {
      throw new FilterError("Invalid filter: unexpected token");
    }
    return expr;
  }

  private parseGroup(kind: "and" | "or"): Expr {
    const parse =
      kind === "or" ? () => this.parseGroup("and") : () => this.parseTerm();
    const items: Expr[] = [];
    do {
      const item = parse();
      items.push(...(item.kind === kind ? item.items : [item]));
    } while (this.accept(kind));
    return items.length === 1 ? items[0]! : { kind, items };
  }

  private parseTerm(): Expr {
    if (this.accept("(")) {
      const expr = this.nested(() => this.parseGroup("or"));
      this.expect(")");
      return expr;
    }
    const left = this.parseOperand();
    const token = this.tokens[this.pos++];
    if (token?.type !== "op") {
      throw new FilterError("Invalid filter: expected a comparison operator");
    }
    return { kind: "cmp", op: token.value, left, right: this.parseOperand() };
  }

  private parseOperand(): Operand {
    const token = this.tokens[this.pos++];
    switch (token?.type) {
      case "string":
      case "number":
        return { kind: "value", value: token.value };
      case "word":
        return this.parseWord(token.value);
      default:
        throw new FilterError("Invalid filter: expected an operand");
    }
  }

  private parseWord(word: string): Operand {
    if (LITERALS.has(word))
      return { kind: "value", value: LITERALS.get(word)! };
    if (this.accept("(")) {
      const args: Operand[] = [];
      this.nested(() => {
        do {
          if (this.accept(")")) return;
          args.push(this.parseOperand());
        } while (this.accept(","));
        this.expect(")");
      });
      return { kind: "call", name: word, args };
    }
    return isMacro(word)
      ? { kind: "macro", name: word }
      : { kind: "field", path: word };
  }

  private nested<T>(parse: () => T): T {
    if (++this.depth > MAX_DEPTH) {
      throw new FilterError("Invalid filter: nested too deeply");
    }
    const result = parse();
    this.depth--;
    return result;
  }

  private accept(type: Token["type"]) {
    if (this.tokens[this.pos]?.type !== type) return false;
    this.pos++;
    return true;
  }

  private expect(type: Token["type"]) {
    if (!this.accept(type)) {
      throw new FilterError(`Invalid filter: expected "${type}"`);
    }
  }
}

export function parseFilter(input: string): Expr | null {
  const syntaxError = filterSyntaxError(input);
  if (syntaxError !== null && input.trim() !== "")
    throw new FilterError(syntaxError);
  const tokens = tokenize(input);
  return tokens.length === 0 ? null : new Parser(tokens).parse();
}

export function parseSort(
  input: string,
): { field: string; dir: "ASC" | "DESC" }[] {
  return input
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const dir = part.startsWith("-") ? ("DESC" as const) : ("ASC" as const);
      const field = /^[+-]/.test(part) ? part.slice(1) : part;
      if (!FIELD.test(field)) {
        throw new FilterError(`Invalid sort field "${field}"`);
      }
      return { field, dir };
    });
}
