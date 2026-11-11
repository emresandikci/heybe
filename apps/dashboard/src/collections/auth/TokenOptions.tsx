import { Button } from "../../ui/Button";
import { randomSecret } from "../oauth2-providers";
import { NumOpt, getIn, groupClass, type OptCtx } from "./opts";
import { Section } from "../../ui/Section";

const TOKENS = [
  ["authToken", "Auth token"],
  ["verificationToken", "Verification token"],
  ["passwordResetToken", "Password reset token"],
  ["emailChangeToken", "Email change token"],
  ["fileToken", "File token"],
] as const;

export function TokenOptions({ c }: { c: OptCtx }) {
  return (
    <Section title="Tokens">
      {TOKENS.map(([key, label]) => {
        const pending = !!getIn(c.draft, [key, "secret"]);
        return (
          <fieldset key={key} className={groupClass}>
            <legend className="px-1 text-sm font-medium">{label}</legend>
            <NumOpt c={c} path={[key, "duration"]} label="Duration (seconds)" />
            {pending ? (
              <div className="flex items-center gap-2 text-sm">
                <span>All issued tokens stop working on save.</span>
                <Button onClick={() => c.set([key, "secret"], undefined)}>
                  Undo
                </Button>
              </div>
            ) : (
              <Button
                className="self-start"
                onClick={() => c.set([key, "secret"], randomSecret())}
              >
                Invalidate all issued tokens
              </Button>
            )}
          </fieldset>
        );
      })}
    </Section>
  );
}
