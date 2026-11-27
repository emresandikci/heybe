import type { CollectionModel } from "@heybejs/client";
import { useState } from "react";
import { useErrorsUnder, useFieldError } from "../../app/errors";
import { useCollections } from "../../app/queries";
import { Button, Checkbox, Select } from "@heybejs/ui";
import {
  activeFields,
  finalIndexes,
  type CollectionDraft,
  type EditorForm,
  type Provider,
} from "../editor-state";
import { parseIndex } from "../index-sql";
import { ProviderLogo } from "../../settings/ProviderLogo";
import { OAUTH2_PROVIDERS } from "../oauth2-providers";
import { RuleInput } from "../rules/RuleInput";
import { ruleChips, ruleSuggest } from "../rules/rule-chips";
import { ProviderDialog } from "./ProviderDialog";
import { TemplatesSection } from "./TemplatesSection";
import { TokenOptions } from "./TokenOptions";
import { AuthSection, BoolOpt, NumOpt, groupClass, type OptCtx } from "./opts";

export function AuthOptions({
  form,
  draft,
  clearError,
  saved,
}: {
  form: EditorForm;
  draft: CollectionDraft;
  clearError: () => void;
  saved?: CollectionModel;
}) {
  const collections = useCollections();
  const c: OptCtx = { form, draft, clearError };
  return (
    <div className="flex flex-col gap-6">
      {draft.name !== "_superusers" && <OAuth2Section c={c} />}
      <AuthSection
        title="Password auth"
        prefixes={["passwordAuth"]}
        defaultOpen
      >
        <BoolOpt
          c={c}
          path="passwordAuth.enabled"
          label="Enable password auth"
        />
        <IdentityFields c={c} />
      </AuthSection>
      <AuthSection title="One-time password" prefixes={["otp"]}>
        <BoolOpt c={c} path="otp.enabled" label="Enable one-time password" />
        <NumOpt c={c} path="otp.duration" label="OTP duration (seconds)" />
        <NumOpt c={c} path="otp.length" label="OTP length" />
      </AuthSection>
      <AuthSection title="Multi-factor auth" prefixes={["mfa"]}>
        <BoolOpt
          c={c}
          path="mfa.enabled"
          label="Enable multi-factor auth"
          hint="Needs at least two other auth methods."
        />
        <NumOpt c={c} path="mfa.duration" label="MFA duration (seconds)" />
        <form.Field name="mfa.rule">
          {(field) => (
            <RuleInput
              label="MFA rule"
              lockable={false}
              value={field.state.value ?? ""}
              onChange={(rule) => field.handleChange(rule ?? "")}
              chips={ruleChips(draft, collections.data ?? [], "mfaRule")}
              suggest={ruleSuggest(draft, collections.data ?? [], "mfaRule")}
              errorPath="mfa.rule"
              emptyHint="Empty rule: MFA applies to every account."
            />
          )}
        </form.Field>
      </AuthSection>
      <AuthSection title="Login alerts" prefixes={["authAlert"]}>
        <BoolOpt c={c} path="authAlert.enabled" label="Send login alerts" />
      </AuthSection>
      <TokenOptions c={c} />
      <TemplatesSection c={c} saved={saved} />
    </div>
  );
}

function IdentityFields({ c }: { c: OptCtx }) {
  const error = useFieldError("passwordAuth.identityFields");
  const selected = c.draft.passwordAuth?.identityFields ?? [];
  const names = new Set(
    activeFields(c.draft)
      .filter((f) => !f.hidden)
      .map((f) => f.name),
  );
  const unique = [
    ...new Set(
      finalIndexes(c.draft)
        .map(parseIndex)
        .filter((i) => i?.unique && i.columns.length === 1)
        .map((i) => i!.columns[0]!)
        .filter((name) => names.has(name)),
    ),
  ];
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-sm font-medium">Identity fields</legend>
      <div className="flex flex-wrap gap-3">
        {unique.map((name) => (
          <Checkbox
            key={name}
            label={name}
            checked={selected.includes(name)}
            onChange={(e) =>
              c.form.setFieldValue(
                "passwordAuth.identityFields",
                e.target.checked
                  ? [...selected, name]
                  : selected.filter((s) => s !== name),
              )
            }
          />
        ))}
      </div>
      <p className="text-xs text-muted">
        Fields with a single column unique index.
      </p>
      {error && <p className="text-xs text-danger-text">{error}</p>}
    </fieldset>
  );
}

const MAPPED = [
  ["id", "ID field"],
  ["name", "Name field"],
  ["username", "Username field"],
  ["avatarURL", "Avatar URL field"],
] as const;

function OAuth2Section({ c }: { c: OptCtx }) {
  const providers = c.draft.oauth2?.providers ?? [];
  const [picked, setPicked] = useState("");
  const [editing, setEditing] = useState<{
    index: number | null;
    provider: Provider;
  } | null>(null);
  const available = OAUTH2_PROVIDERS.filter(
    (p) => !providers.some((x) => x.name === p.name),
  );
  const setProviders = (list: Provider[]) => {
    c.clearError();
    c.form.setFieldValue("oauth2.providers", list);
  };
  const fields = activeFields(c.draft).map((f) => f.name);

  return (
    <AuthSection title="OAuth2" prefixes={["oauth2"]} defaultOpen>
      <BoolOpt c={c} path="oauth2.enabled" label="Enable OAuth2" />
      <ul className="flex flex-col gap-2">
        {providers.map((p, i) => (
          <ProviderRow
            key={p.name}
            provider={p}
            errorPath={`oauth2.providers.${i}`}
            onEdit={() => setEditing({ index: i, provider: p })}
            onRemove={() => setProviders(providers.filter((_, j) => j !== i))}
          />
        ))}
      </ul>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Select
            label="Provider"
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
          >
            <option value="" disabled>
              Choose a provider
            </option>
            {available.map((p) => (
              <option key={p.name} value={p.name}>
                {p.displayName} ({p.name})
              </option>
            ))}
          </Select>
        </div>
        <Button
          disabled={!picked}
          onClick={() => {
            setEditing({ index: null, provider: { name: picked } });
            setPicked("");
          }}
        >
          Add provider
        </Button>
      </div>
      <fieldset className={groupClass}>
        <legend className="px-1 text-sm font-medium">Mapped fields</legend>
        {MAPPED.map(([key, label]) => (
          <c.form.Field key={key} name={`oauth2.mappedFields.${key}`}>
            {(field) => (
              <Select
                label={label}
                value={field.state.value ?? ""}
                onChange={(e) => field.handleChange(e.target.value)}
              >
                <option value="">Not mapped</option>
                {fields.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            )}
          </c.form.Field>
        ))}
      </fieldset>
      {editing && (
        <ProviderDialog
          provider={editing.provider}
          errorPath={
            editing.index === null
              ? "oauth2.providers.new"
              : `oauth2.providers.${editing.index}`
          }
          onCancel={() => setEditing(null)}
          onSave={(p) => {
            if (editing.index === null) setProviders([...providers, p]);
            else
              c.form.setFieldValue(
                "oauth2.providers",
                providers.map((x, j) => (j === editing.index ? p : x)),
              );
            setEditing(null);
          }}
        />
      )}
    </AuthSection>
  );
}

function ProviderRow({
  provider,
  errorPath,
  onEdit,
  onRemove,
}: {
  provider: Provider;
  errorPath: string;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const errors = useErrorsUnder(`${errorPath}.`);
  const name =
    String(provider.displayName || "") ||
    OAUTH2_PROVIDERS.find((p) => p.name === provider.name)?.displayName ||
    provider.name;
  return (
    <li className="flex flex-col gap-1 rounded border border-line p-2">
      <div className="flex items-center gap-2">
        <ProviderLogo name={provider.name} displayName={name} />
        <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
        <Button
          variant="ghost"
          aria-label={`Edit provider ${name}`}
          onClick={onEdit}
        >
          Edit
        </Button>
        <Button
          variant="ghost"
          aria-label={`Remove provider ${name}`}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
      {errors.map(([path, message]) => (
        <p key={path} className="text-xs text-danger-text">
          {path.slice(errorPath.length + 1)}: {message}
        </p>
      ))}
    </li>
  );
}
