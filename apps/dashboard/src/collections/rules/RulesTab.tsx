import { useCollections } from "../../app/queries";
import type { CollectionDraft } from "../editor-state";
import { RuleInput } from "./RuleInput";
import { ruleChips, type RuleKey } from "./rule-chips";

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
  draft,
  update,
}: {
  draft: CollectionDraft;
  update: (fn: (d: CollectionDraft) => CollectionDraft) => void;
}) {
  const collections = useCollections();
  return (
    <div className="flex flex-col gap-3">
      {rulesFor(draft.type).map(({ key, label, emptyHint }) => (
        <RuleInput
          key={key}
          label={label}
          emptyHint={emptyHint}
          errorPath={key}
          value={(draft[key] as string | null | undefined) ?? null}
          chips={ruleChips(draft, collections.data ?? [], key)}
          onChange={(value) => update((d) => ({ ...d, [key]: value }))}
        />
      ))}
    </div>
  );
}
