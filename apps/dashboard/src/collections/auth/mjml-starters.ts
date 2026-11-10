export const TEMPLATE_KINDS = [
  "verification",
  "resetPassword",
  "confirmEmailChange",
  "otp",
  "authAlert",
] as const;

export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

const text = (content: string) => `        <mj-text>${content}</mj-text>`;

const button = (href: string, label: string) =>
  `        <mj-button href="{APP_URL}/_/#/auth/${href}/{TOKEN}" background-color="#16161a">${label}</mj-button>`;

function document(title: string, lines: string[]): string {
  return [
    "<mjml>",
    "  <mj-head>",
    `    <mj-title>${title}</mj-title>`,
    "    <mj-attributes>",
    `      <mj-all font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" />`,
    '      <mj-text font-size="14px" line-height="1.5" />',
    "    </mj-attributes>",
    "  </mj-head>",
    "  <mj-body>",
    "    <mj-section>",
    "      <mj-column>",
    text("Hello,"),
    ...lines,
    text("Thanks,<br />{APP_NAME} team"),
    "      </mj-column>",
    "    </mj-section>",
    "  </mj-body>",
    "</mjml>",
    "",
  ].join("\n");
}

export function mjmlStarter(kind: TemplateKind, superuser: boolean): string {
  const account = superuser
    ? "{APP_NAME} superuser account"
    : "{APP_NAME} account";
  switch (kind) {
    case "verification":
      return document("Verify your {APP_NAME} email", [
        text(
          superuser
            ? "Click on the button below to verify the email of your {APP_NAME} superuser account."
            : "Thank you for joining us at {APP_NAME}. Click on the button below to verify your email address.",
        ),
        button("confirm-verification", "Verify"),
        text(
          "<i>If you didn't recently register, please ignore this email.</i>",
        ),
      ]);
    case "resetPassword":
      return document("Reset your {APP_NAME} password", [
        text(
          `Click on the button below to reset the password of your ${account}.`,
        ),
        button("confirm-password-reset", "Reset password"),
        text(
          "<i>If you didn't ask to reset your password, please ignore this email.</i>",
        ),
      ]);
    case "confirmEmailChange":
      return document("Confirm your {APP_NAME} new email address", [
        text(
          `Click on the button below to confirm the new email address of your ${account}.`,
        ),
        button("confirm-email-change", "Confirm new email"),
        text(
          "<i>If you didn't ask to change your email address, please ignore this email.</i>",
        ),
      ]);
    case "otp":
      return document("OTP for {APP_NAME}", [
        text(
          `Your one-time password for your ${account} is: <strong>{OTP}</strong>`,
        ),
        text(
          "<i>If you didn't ask for the one-time password, you can ignore this email.</i>",
        ),
      ]);
    case "authAlert":
      return document("Login from a new location", [
        text(`We noticed a login to your ${account} from a new location:`),
        text("<em>{ALERT_INFO}</em>"),
        text(
          "<strong>If this wasn't you, you should immediately change your {APP_NAME} account password to revoke access from all other locations.</strong>",
        ),
        text("If this was you, you may disregard this email."),
      ]);
  }
}
