const WHITESPACE = ["\t", "\n", "\v", "\f", "\r", " ", "\u0085", " "];

export interface TokenizerOptions {
  separators: string;
  keepSeparator?: boolean;
  ignoreParenthesis?: boolean;
}

// Port of PB tools/tokenizer.
export class Tokenizer {
  private readonly chars: string[];
  private readonly trim: string[];
  private pos = 0;

  constructor(
    input: string,
    private readonly opts: TokenizerOptions,
  ) {
    this.chars = [...input];
    this.trim = WHITESPACE.filter((c) => !opts.separators.includes(c));
  }

  // null at the end of the input; PB reads NUL as its eof rune
  scan(): string | null {
    while (this.pos < this.chars.length) {
      if (this.chars[this.pos] === "\0") {
        this.pos++;
        return null;
      }
      const token = this.readToken();
      if (token !== "") return token;
    }
    return null;
  }

  scanAll(): string[] {
    const tokens: string[] = [];
    for (let t = this.scan(); t !== null; t = this.scan()) tokens.push(t);
    return tokens;
  }

  private readToken(): string {
    const { separators, keepSeparator, ignoreParenthesis } = this.opts;
    let buf = "";
    let parens = 0;
    let quote = "";
    let prev = "";
    while (this.pos < this.chars.length) {
      const ch = this.chars[this.pos++]!;
      if (ch === "\0") break;
      if (prev !== "\\") {
        if (!ignoreParenthesis && ch === "(" && quote === "") parens++;
        else if (!ignoreParenthesis && ch === ")" && parens > 0 && quote === "")
          parens--;
        else if (ch === "'" || ch === '"' || ch === "`") {
          if (quote === ch) quote = "";
          else if (quote === "") quote = ch;
        }
      }
      if (separators.includes(ch) && parens === 0 && quote === "") {
        if (keepSeparator) buf += ch;
        break;
      }
      prev = ch;
      buf += ch;
    }
    if (parens > 0 || quote !== "")
      throw new Error(
        `unbalanced parenthesis or quoted expression: ${JSON.stringify(buf)}`,
      );
    return this.strip(buf);
  }

  private strip(s: string): string {
    let a = 0;
    let b = s.length;
    while (a < b && this.trim.includes(s[a]!)) a++;
    while (b > a && this.trim.includes(s[b - 1]!)) b--;
    return s.slice(a, b);
  }
}

export const tokenize = (input: string, opts: TokenizerOptions) =>
  new Tokenizer(input, opts).scanAll();
