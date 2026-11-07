type TokenType =
  | "eof"
  | "whitespace"
  | "join"
  | "sign"
  | "identifier"
  | "function"
  | "number"
  | "text"
  | "group"
  | "comment";

interface Token {
  type: TokenType;
  literal: string;
}

class ScanError extends Error {
  constructor(
    message: string,
    readonly literal = "",
  ) {
    super(message);
  }
}

const SIGNS = new Set([
  "=",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "~",
  "!~",
  "?=",
  "?!=",
  "?~",
  "?!~",
  "?<",
  "?<=",
  "?>",
  "?>=",
]);
const MAX_FUNC_DEPTH = 3;

const isWhitespace = (c: string) => c === " " || c === "\t" || c === "\n";
const isLetter = (c: string) => /^[A-Za-z]$/.test(c);
const isDigit = (c: string) => /^[0-9]$/.test(c);
const isTextStart = (c: string) => c === "'" || c === '"';
const isNumberStart = (c: string) => c === "-" || isDigit(c);
const isSignStart = (c: string) => "=?!><~".includes(c);
const isJoinStart = (c: string) => c === "&" || c === "|";
const isGroupStart = (c: string) => c === "(";
const isCommentStart = (c: string) => c === "/";
const isSpecialStart = (c: string) => c === "@" || c === "_" || c === "#";
const isIdentStart = (c: string) => isLetter(c) || isSpecialStart(c);
const isCombine = (c: string) => c === "." || c === ":";

function isValidIdentifier(literal: string): boolean {
  return (
    literal.length > 0 &&
    !isCombine(literal.at(-1)!) &&
    (literal.length !== 1 || !isSpecialStart(literal))
  );
}

// Go's %q for a string
function quote(text: string): string {
  return JSON.stringify(text).replace(
    /\\u00([0-9a-f]{2})/g,
    (_, hex: string) => `\\x${hex}`,
  );
}

// Go's %q for a rune
function quoteRune(ch: string): string {
  if (ch === "'") return "'\\''";
  if (ch === "\\") return "'\\\\'";
  const named: Record<string, string> = {
    "\x07": "\\a",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
    "\v": "\\v",
  };
  if (named[ch]) return `'${named[ch]}'`;
  const code = ch.codePointAt(0)!;
  if (code < 0x20 || code === 0x7f)
    return `'\\x${code.toString(16).padStart(2, "0")}'`;
  return `'${ch}'`;
}

class Scanner {
  private readonly data: string[];
  private pos = 0;
  private lastRead = false;

  constructor(text: string) {
    this.data = Array.from(text);
  }

  scan(): Token {
    const ch = this.read();
    if (ch === null) return { type: "eof", literal: "" };
    this.unread();
    if (isWhitespace(ch)) return this.whitespace();
    if (isGroupStart(ch)) return this.group();
    if (isIdentStart(ch)) return this.identifier(MAX_FUNC_DEPTH);
    if (isNumberStart(ch)) return this.number();
    if (isTextStart(ch)) return this.text(false);
    if (isSignStart(ch)) return this.sign();
    if (isJoinStart(ch)) return this.join();
    if (isCommentStart(ch)) return this.comment();
    throw new ScanError(`unexpected character ${quoteRune(ch)}`);
  }

  private read(): string | null {
    if (this.pos >= this.data.length) {
      this.lastRead = false;
      return null;
    }
    this.lastRead = true;
    return this.data[this.pos++]!;
  }

  private unread() {
    if (!this.lastRead) return;
    this.pos--;
    this.lastRead = false;
  }

  private whitespace(): Token {
    let literal = "";
    for (;;) {
      const ch = this.read();
      if (ch === null) break;
      if (!isWhitespace(ch)) {
        this.unread();
        break;
      }
      literal += ch;
    }
    return { type: "whitespace", literal };
  }

  private number(): Token {
    let literal = "";
    let hadDot = false;
    for (;;) {
      const ch = this.read();
      if (ch === null) break;
      if (
        !isDigit(ch) &&
        (ch !== "-" || literal.length !== 0) &&
        (ch !== "." || hadDot)
      ) {
        this.unread();
        break;
      }
      literal += ch;
      if (ch === ".") hadDot = true;
    }
    if (literal === "-" || literal.startsWith(".") || literal.endsWith("."))
      throw new ScanError(`invalid number ${quote(literal)}`, literal);
    return { type: "number", literal };
  }

  private text(preserveQuotes: boolean): Token {
    const first = this.read()!;
    let literal = preserveQuotes ? first : "";
    let escapeNext = false;
    let closed = false;
    for (;;) {
      const ch = this.read();
      if (ch === null) break;
      if (escapeNext) {
        escapeNext = false;
        if (preserveQuotes) literal += ch;
        else if (ch === "n") literal += "\n";
        else if (ch === "t") literal += "\t";
        else if (ch === "r") literal += "\r";
        else if (ch === "\\" || ch === "'" || ch === '"') literal += ch;
        else literal += `\\${ch}`;
      } else if (ch === "\\") {
        escapeNext = true;
        if (preserveQuotes) literal += ch;
      } else if (ch === first) {
        closed = true;
        if (preserveQuotes) literal += ch;
        break;
      } else literal += ch;
    }
    if (!closed) {
      if (!preserveQuotes) literal = first + literal;
      throw new ScanError(`invalid quoted text ${quote(literal)}`, literal);
    }
    return { type: "text", literal };
  }

  private comment(): Token {
    const first = this.read();
    const second = this.read();
    if (
      first === null ||
      !isCommentStart(first) ||
      second === null ||
      !isCommentStart(second)
    )
      throw new ScanError("invalid comment");
    for (;;) {
      const ch = this.read();
      if (ch === null || ch === "\n") break;
    }
    return { type: "comment", literal: "" };
  }

  private identifier(funcDepth: number): Token {
    let literal = this.read()!;
    for (;;) {
      const ch = this.read();
      if (ch === null) break;
      if (ch === "(") {
        if (funcDepth <= 0)
          throw new ScanError(
            `max nested function arguments reached (max: ${MAX_FUNC_DEPTH})`,
            literal,
          );
        if (!isValidIdentifier(literal))
          throw new ScanError(
            `invalid function name ${quote(literal)}`,
            literal,
          );
        this.unread();
        return this.functionArgs(literal, funcDepth);
      }
      if (!isLetter(ch) && !isDigit(ch) && !isCombine(ch) && ch !== "_") {
        this.unread();
        break;
      }
      literal += ch;
    }
    if (!isValidIdentifier(literal))
      throw new ScanError(`invalid identifier ${quote(literal)}`, literal);
    return { type: "identifier", literal };
  }

  private sign(): Token {
    let literal = "";
    for (;;) {
      const ch = this.read();
      if (ch === null) break;
      if (!isSignStart(ch)) {
        this.unread();
        break;
      }
      literal += ch;
    }
    if (!SIGNS.has(literal))
      throw new ScanError(`invalid sign operator ${quote(literal)}`);
    return { type: "sign", literal };
  }

  private join(): Token {
    let literal = "";
    for (;;) {
      const ch = this.read();
      if (ch === null) break;
      if (!isJoinStart(ch)) {
        this.unread();
        break;
      }
      literal += ch;
    }
    if (literal !== "&&" && literal !== "||")
      throw new ScanError(`invalid join operator ${quote(literal)}`);
    return { type: "join", literal };
  }

  private group(): Token {
    this.read();
    let open = 1;
    let literal = "";
    for (;;) {
      const ch = this.read();
      if (ch === null) break;
      if (isGroupStart(ch)) {
        open++;
        literal += ch;
      } else if (isTextStart(ch)) {
        this.unread();
        literal += this.text(true).literal;
      } else if (ch === ")") {
        open--;
        if (open <= 0) break;
        literal += ch;
      } else literal += ch;
    }
    if (open > 0)
      throw new ScanError(
        `invalid formatted group - missing ${open} closing bracket(s)`,
      );
    return { type: "group", literal };
  }

  private functionArgs(name: string, funcDepth: number): Token {
    if (this.read() !== "(")
      throw new ScanError(
        `invalid or incomplete function call ${quote(name)}`,
        name,
      );
    let expectComma = false;
    let closed = false;
    const wrap = (what: string, literal: string, e: unknown) =>
      new ScanError(
        `invalid ${what} argument ${quote(literal)} in function ${quote(name)}: ${(e as Error).message}`,
        name,
      );
    for (;;) {
      const ch = this.read();
      if (ch === null) break;
      if (ch === ")") {
        closed = true;
        break;
      }
      if (isWhitespace(ch)) {
        this.unread();
        this.whitespace();
        continue;
      }
      if (isCommentStart(ch)) {
        this.unread();
        try {
          this.comment();
        } catch (e) {
          throw new ScanError(
            `failed to scan comment in function ${quote(name)}: ${(e as Error).message}`,
            name,
          );
        }
        continue;
      }
      const isComma = ch === ",";
      if (expectComma && !isComma)
        throw new ScanError(
          `expected comma after the last argument in function ${quote(name)}`,
          name,
        );
      if (!expectComma && isComma)
        throw new ScanError(
          `unexpected comma in function ${quote(name)}`,
          name,
        );
      expectComma = false;
      if (isComma) continue;

      this.unread();
      if (isIdentStart(ch)) {
        try {
          this.identifier(funcDepth - 1);
        } catch (e) {
          throw wrap("identifier", this.lastLiteral(e), e);
        }
      } else if (isNumberStart(ch)) {
        try {
          this.number();
        } catch (e) {
          throw wrap("number", this.lastLiteral(e), e);
        }
      } else if (isTextStart(ch)) {
        try {
          this.text(false);
        } catch (e) {
          throw wrap("text", this.lastLiteral(e), e);
        }
      } else {
        this.read();
        throw new ScanError(
          `unsupported argument character ${quoteRune(ch)} in function ${quote(name)}`,
          name,
        );
      }
      expectComma = true;
    }
    if (!closed)
      throw new ScanError(
        `invalid or incomplete function ${quote(name)} (expected ')')`,
        name,
      );
    return { type: "function", literal: name };
  }

  // the literal of the token that failed to scan, which Go returns next to the error
  private lastLiteral(e: unknown): string {
    return e instanceof ScanError ? e.literal : "";
  }
}

const EMPTY = "empty filter expression";
const INCOMPLETE = "invalid or incomplete filter expression";

const isOperand = (t: Token) =>
  t.type === "identifier" ||
  t.type === "text" ||
  t.type === "number" ||
  t.type === "function";

type Step = "beforeSign" | "sign" | "afterSign" | "join";

// Mirrors the syntax errors of github.com/ganigeorgiev/fexpr, which PocketBase reports in rule validation.
export function filterSyntaxError(text: string): string | null {
  try {
    parse(text);
    return null;
  } catch (e) {
    if (e instanceof ScanError || e instanceof ParseError) return e.message;
    throw e;
  }
}

class ParseError extends Error {}

function parse(text: string): number {
  const scanner = new Scanner(text);
  let step: Step = "beforeSign";
  let count = 0;
  let started = false;
  for (;;) {
    const t = scanner.scan();
    if (t.type === "eof") break;
    if (t.type === "whitespace" || t.type === "comment") continue;

    if (t.type === "group") {
      if (parse(t.literal) > 0) count++;
      step = "join";
      continue;
    }

    const desc = `${quote(t.literal)} (${t.type})`;
    switch (step) {
      case "beforeSign":
        if (!isOperand(t))
          throw new ParseError(
            `expected left operand (identifier, function, text or number), got ${desc}`,
          );
        started = true;
        step = "sign";
        break;
      case "sign":
        if (t.type !== "sign")
          throw new ParseError(`expected a sign operator, got ${desc}`);
        step = "afterSign";
        break;
      case "afterSign":
        if (!isOperand(t))
          throw new ParseError(
            `expected right operand (identifier, function text or number), got ${desc}`,
          );
        count++;
        step = "join";
        break;
      case "join":
        if (t.type !== "join")
          throw new ParseError(`expected && or ||, got ${desc}`);
        step = "beforeSign";
        break;
    }
  }
  if (step !== "join") {
    throw new ParseError(count === 0 && !started ? EMPTY : INCOMPLETE);
  }
  return count;
}
