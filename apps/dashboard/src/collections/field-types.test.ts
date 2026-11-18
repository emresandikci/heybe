import { expect, test } from "bun:test";
import { fieldDefaults as serverDefaults } from "../../../../packages/core/src/collections/field-settings";
import { FIELD_TYPES, fieldDefaults } from "./field-types";

test("fieldDefaults matches the server for every type", () => {
  expect(FIELD_TYPES).toHaveLength(14);
  for (const { type } of FIELD_TYPES) {
    const { id: _id, ...server } = serverDefaults(type);
    const { id: _ownId, _key, ...ours } = fieldDefaults(type);
    expect(ours as Record<string, unknown>).toEqual(server);
  }
});
