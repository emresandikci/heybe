import { expect, test } from "bun:test";
import {
  authSystemFields,
  autodateFields,
  idField,
} from "../../../../packages/heybe/src/collections/scaffold";
import { collectionsFixture } from "./fixtures";

const shape = (f: Record<string, unknown>) => ({
  name: f.name,
  type: f.type,
  hidden: f.hidden,
  system: f.system,
  required: f.required ?? false,
});

const byName = (a: { name: unknown }, b: { name: unknown }) =>
  String(a.name).localeCompare(String(b.name));

test("fixture system fields match the server scaffold", () => {
  for (const c of collectionsFixture) {
    const expected = [
      idField(),
      ...(c.type === "auth" ? authSystemFields() : []),
      ...(c.type === "view" ? [] : autodateFields(c.system)),
    ]
      .map(shape)
      .sort(byName);
    const names = expected.map((f) => f.name);
    const actual = (c.fields as Record<string, unknown>[])
      .filter((f) => names.includes(f.name as string))
      .map(shape)
      .sort(byName);
    expect(actual).toEqual(expected);
  }
});
