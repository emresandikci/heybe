import { useCollections } from "../../app/queries";
import type { CollectionDraft, EditorForm } from "../editor-state";
import { RuleInput } from "./RuleInput";
import { ruleChips, ruleSuggest, type RuleKey } from "./rule-chips";

const RULES: { key: RuleKey; label: string; emptyHint?: string }[] = [
  { key: "listRule", label: "List/Search rule" },
  { key: "viewRule", label: "View rule" },
  { key: "createRule", label: "Create rule" },
  { key: "updateRule", label: "Update rule" },
  { key: "deleteRule", label: "Delete rule" },
  {
    key: "authRule",
    label: "Auth rule",
    emptyHint: "Empty rule: any account with valid credentials can sign in.",
  },
  {
    key: "manageRule",
    label: "Manage rule",
    emptyHint: "A manage rule cannot be empty. Write a rule or lock it.",
  },
];

export const RULE_KEYS: string[] = RULES.map((r) => r.key);

function rulesFor(type: CollectionDraft["type"]) {
  if (type === "view") return RULES.slice(0, 2);
  if (type === "auth") return RULES;
  return RULES.slice(0, 5);
}

export function RulesTab({
  form,
  draft,
}: {
  form: EditorForm;
  draft: CollectionDraft;
}) {
  const collections = useCollections();
  return (
    <div className="flex flex-col gap-3">
      {rulesFor(draft.type).map(({ key, label, emptyHint }) => (
        <form.Field key={key} name={key}>
          {(field) => (
            <RuleInput
              label={label}
              emptyHint={emptyHint}
              errorPath={key}
              value={field.state.value ?? null}
              chips={ruleChips(draft, collections.data ?? [], key)}
              suggest={ruleSuggest(draft, collections.data ?? [], key)}
              onChange={field.handleChange}
            />
          )}
        </form.Field>
      ))}
    </div>
  );
}
