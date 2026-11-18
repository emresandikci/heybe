import { Button } from "@heybe/ui";
import { randomSecret } from "../oauth2-providers";
import { NumOpt, AuthSection, groupClass, type OptCtx } from "./opts";

const TOKENS = [
  ["authToken", "Auth token"],
  ["verificationToken", "Verification token"],
  ["passwordResetToken", "Password reset token"],
  ["emailChangeToken", "Email change token"],
  ["fileToken", "File token"],
] as const;

export function TokenOptions({ c }: { c: OptCtx }) {
  return (
    <AuthSection title="Tokens" prefixes={TOKENS.map(([key]) => key)}>
      {TOKENS.map(([key, label]) => {
        const pending = !!c.draft[key]?.secret;
        return (
          <fieldset key={key} className={groupClass}>
            <legend className="px-1 text-sm font-medium">{label}</legend>
            <NumOpt c={c} path={`${key}.duration`} label="Duration (seconds)" />
            {pending ? (
              <div className="flex items-center gap-2 text-sm">
                <span>All issued tokens stop working on save.</span>
                <Button
                  onClick={() =>
                    c.form.setFieldValue(`${key}.secret`, undefined)
                  }
                >
                  Undo
                </Button>
              </div>
            ) : (
              <Button
                className="self-start"
                onClick={() =>
                  c.form.setFieldValue(`${key}.secret`, randomSecret())
                }
              >
                Invalidate all issued tokens
              </Button>
            )}
          </fieldset>
        );
      })}
    </AuthSection>
  );
}
