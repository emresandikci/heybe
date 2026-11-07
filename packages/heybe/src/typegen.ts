import { writeFileSync } from "node:fs";
import type { App } from "./app";
import type { Collection, Field } from "./collections/model";

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function isMulti(f: Field): boolean {
  return Number(f.maxSelect) > 1;
}

function tsType(f: Field): string | null {
  switch (f.type) {
    case "number":
      return "number";
    case "bool":
      return "boolean";
    case "json":
      return "unknown";
    case "password":
      return null;
    case "select": {
      const values = (f.values as string[]).map((v) => JSON.stringify(v));
      const union = values.join(" | ");
      return isMulti(f) ? `(${union})[]` : union;
    }
    case "relation":
    case "file":
      return isMulti(f) ? "string[]" : "string";
    default:
      return "string";
  }
}

function key(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function render(c: Collection): string {
  const lines = c.fields
    .filter((f) => !f.hidden)
    .flatMap((f) => {
      const type = tsType(f);
      return type === null ? [] : [`      ${key(f.name)}: ${type};`];
    });
  return `    ${key(c.name)}: {\n${lines.join("\n")}\n    };`;
}

export function generateTypes(collections: Collection[]): string {
  const body = collections
    .filter((c) => !c.name.startsWith("_") && c.type !== "view")
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(render)
    .join("\n");
  return `declare module "@heybe/query" {\n  interface Collections {\n${body}\n  }\n}\nexport {};\n`;
}

export function writeTypes(app: App, out: string) {
  writeFileSync(out, generateTypes(app.collections.all()));
}

export function writeTypesSafely(app: App, out: string) {
  try {
    writeTypes(app, out);
  } catch (err) {
    console.warn(`Failed to write ${out}`, err);
  }
}
