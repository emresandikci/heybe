import { expect, test } from "bun:test";
import {
  authSystemFields,
  autodateFields,
  idField,
} from "../../../../packages/core/src/collections/scaffold";
import { publicSettings } from "../../../../packages/core/src/settings";
import { collectionsFixture, settingsFixture } from "./fixtures";

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

test("settings fixture is what the server returns: no secrets", () => {
  const withSecrets = {
    ...settingsFixture,
    smtp: { ...settingsFixture.smtp, password: "x" },
    s3: { ...settingsFixture.s3, secret: "x" },
    backups: {
      ...settingsFixture.backups,
      s3: { ...settingsFixture.backups.s3, secret: "x" },
    },
  };
  expect(publicSettings(withSecrets)).toEqual(settingsFixture);
});
