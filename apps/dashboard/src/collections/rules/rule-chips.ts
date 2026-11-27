import type { CollectionModel } from "@heybejs/client";
import { createSuggest } from "../../filter-language";
import { activeFields, type CollectionDraft } from "../editor-state";

export type RuleKey =
  | "listRule"
  | "viewRule"
  | "createRule"
  | "updateRule"
  | "deleteRule"
  | "authRule"
  | "manageRule";

const MACROS = [
  "@now",
  "@todayStart",
  "@todayEnd",
  "@monthStart",
  "@monthEnd",
  "@yearStart",
  "@yearEnd",
];

export function ruleChips(
  d: CollectionDraft,
  all: CollectionModel[],
  key: RuleKey | "mfaRule",
): string[] {
  const fields = activeFields(d)
    .map((f) => f.name)
    .filter(Boolean);
  const body =
    key === "createRule" || key === "updateRule"
      ? fields.map((f) => `@request.body.${f}`)
      : [];
  return [
    ...fields,
    "@request.auth.id",
    "@request.auth.collectionName",
    ...body,
    "@request.query.",
    "@request.headers.",
    ...all
      .filter((c) => !d.id || c.id !== d.id)
      .map((c) => `@collection.${c.name}.`),
    ...MACROS,
  ];
}

export function ruleSuggest(
  d: CollectionDraft,
  all: CollectionModel[],
  key: RuleKey | "mfaRule",
) {
  return createSuggest({
    collectionId: d.id,
    fields: activeFields(d).filter((f) => f.name),
    collections: all,
    request: { body: key === "createRule" || key === "updateRule" },
  });
}
