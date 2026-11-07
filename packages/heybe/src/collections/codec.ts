import { AUTH_KEYS, AUTH_SHAPE, TOKEN_KEYS } from "./auth-options";
import { type Shape, decode, decodeFields, zero } from "./field-settings";
import type { Collection } from "./model";

const COLLECTION_SHAPE: Shape = {
  id: "string",
  name: "string",
  type: "string",
  system: "bool",
  listRule: "string?",
  viewRule: "string?",
  createRule: "string?",
  updateRule: "string?",
  deleteRule: "string?",
  indexes: "strings",
  viewQuery: "string",
  ...AUTH_SHAPE,
};

// Merges a request body into a collection, like PB unmarshals JSON on top of the loaded model.
export function decodeCollection(
  base: Collection,
  body: Record<string, unknown>,
): Collection {
  const target = {
    ...(base.type === "auth" ? {} : zero(AUTH_SHAPE)),
    ...structuredClone(base),
  } as Record<string, unknown>;
  decode(target, body, COLLECTION_SHAPE);
  if (Object.hasOwn(body, "fields"))
    target.fields = body.fields === null ? [] : decodeFields(body.fields);
  return target as Collection;
}

export function serializeCollection(c: Collection): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: c.id,
    listRule: c.listRule,
    viewRule: c.viewRule,
    createRule: c.createRule,
    updateRule: c.updateRule,
    deleteRule: c.deleteRule,
    name: c.name,
    type: c.type,
    fields: c.fields,
    indexes: c.indexes,
    created: c.created,
    updated: c.updated,
    system: c.system,
  };
  if (c.type === "view") out.viewQuery = c.viewQuery ?? "";
  if (c.type !== "auth") return out;

  for (const key of AUTH_KEYS) out[key] = c[key];
  for (const key of TOKEN_KEYS) {
    out[key] = { duration: (c[key] as { duration: number }).duration };
  }
  const oauth2 = c.oauth2 as { providers: Record<string, unknown>[] };
  out.oauth2 = {
    ...oauth2,
    providers: oauth2.providers.map(({ clientSecret, ...rest }) => rest),
  };
  return out;
}
