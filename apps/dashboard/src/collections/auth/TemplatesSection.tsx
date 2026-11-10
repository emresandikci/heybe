import type { CollectionModel } from "@heybe/client";
import { useState } from "react";
import { Button } from "../../ui/Button";
import type { TemplateKind } from "./mjml-starters";
import { TemplateBody } from "./TemplateBody";
import { TestEmailDialog } from "./TestEmailDialog";
import { Section, TextOpt, getIn, groupClass, type OptCtx } from "./opts";

const TEMPLATES: {
  path: string[];
  label: string;
  kind: TemplateKind;
  template: string;
}[] = [
  {
    path: ["verificationTemplate"],
    label: "Verification email",
    kind: "verification",
    template: "verification",
  },
  {
    path: ["resetPasswordTemplate"],
    label: "Password reset email",
    kind: "resetPassword",
    template: "password-reset",
  },
  {
    path: ["confirmEmailChangeTemplate"],
    label: "Email change email",
    kind: "confirmEmailChange",
    template: "email-change",
  },
  {
    path: ["otp", "emailTemplate"],
    label: "OTP email",
    kind: "otp",
    template: "otp",
  },
  {
    path: ["authAlert", "emailTemplate"],
    label: "Login alert email",
    kind: "authAlert",
    template: "login-alert",
  },
];

export function TemplatesSection({
  c,
  saved,
}: {
  c: OptCtx;
  saved?: CollectionModel;
}) {
  const [testing, setTesting] = useState<string | null>(null);
  return (
    <Section title="Email templates">
      {TEMPLATES.map(({ path, label, kind, template }) => {
        const changed =
          JSON.stringify(getIn(c.draft, path)) !==
          JSON.stringify(getIn(saved, path));
        return (
          <fieldset key={template} className={groupClass}>
            <legend className="px-1 text-sm font-medium">{label}</legend>
            <TextOpt c={c} path={[...path, "subject"]} label="Subject" />
            <TemplateBody
              c={c}
              path={path}
              label={label}
              kind={kind}
              superuser={c.draft.name === "_superusers"}
            />
            {saved && (
              <div className="flex items-center gap-2">
                <Button disabled={changed} onClick={() => setTesting(template)}>
                  Send test email
                </Button>
                {changed && (
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    Save first: the test email uses the saved template.
                  </span>
                )}
              </div>
            )}
          </fieldset>
        );
      })}
      {testing && saved && (
        <TestEmailDialog
          collection={saved.name}
          template={testing}
          onClose={() => setTesting(null)}
        />
      )}
    </Section>
  );
}
