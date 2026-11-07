import { randomSecret } from "../util";
import {
  type Collection,
  type CollectionType,
  type Field,
  type FieldType,
  collectionId,
  fieldId,
} from "./model";

const ID_PATTERN = "^[a-z0-9]+$";

function field(
  type: FieldType,
  name: string,
  options: Record<string, unknown> = {},
): Field {
  return {
    id: fieldId(type, name),
    name,
    type,
    system: false,
    hidden: false,
    presentable: false,
    help: "",
    ...options,
  };
}

export function idField(): Field {
  return field("text", "id", {
    system: true,
    primaryKey: true,
    required: true,
    min: 15,
    max: 15,
    pattern: ID_PATTERN,
    autogeneratePattern: "[a-z0-9]{15}",
  });
}

export function authSystemFields(): Field[] {
  return [
    field("password", "password", {
      system: true,
      hidden: true,
      required: true,
      min: 8,
      max: 0,
      cost: 0,
      pattern: "",
    }),
    field("text", "tokenKey", {
      system: true,
      hidden: true,
      required: true,
      primaryKey: false,
      min: 30,
      max: 60,
      pattern: "",
      autogeneratePattern: "[a-zA-Z0-9]{50}",
    }),
    field("email", "email", {
      system: true,
      required: true,
      onlyDomains: [],
      exceptDomains: [],
    }),
    field("bool", "emailVisibility", { system: true, required: false }),
    field("bool", "verified", { system: true, required: false }),
  ];
}

export function autodateFields(system: boolean): Field[] {
  return [
    {
      ...field("autodate", "created", {
        system,
        onCreate: true,
        onUpdate: false,
      }),
      help: undefined,
    },
    {
      ...field("autodate", "updated", {
        system,
        onCreate: true,
        onUpdate: true,
      }),
      help: undefined,
    },
  ].map(({ help, ...rest }) => rest);
}

const TEMPLATE_SIGNATURE = "<p>\n  Thanks,<br/>\n  {APP_NAME} team\n</p>";

function template(subject: string, lines: string[]) {
  return {
    subject,
    body: `<p>Hello,</p>\n${lines.join("\n")}\n${TEMPLATE_SIGNATURE}`,
  };
}

function tokenConfig(duration: number) {
  return { secret: randomSecret(50), duration };
}

export function authOptions(): Record<string, unknown> {
  return {
    authRule: "",
    manageRule: null,
    authAlert: {
      enabled: true,
      emailTemplate: template("Login from a new location", [
        "<p>We noticed a login to your {APP_NAME} account from a new location:</p>",
        "<p><em>{ALERT_INFO}</em></p>",
        "<p><strong>If this wasn't you, you should immediately change your {APP_NAME} account password to revoke access from all other locations.</strong></p>",
        "<p>If this was you, you may disregard this email.</p>",
      ]),
    },
    oauth2: {
      providers: [],
      mappedFields: { id: "", name: "", username: "", avatarURL: "" },
      enabled: false,
    },
    passwordAuth: { enabled: true, identityFields: ["email"] },
    mfa: { enabled: false, duration: 600, rule: "" },
    otp: {
      enabled: false,
      duration: 180,
      length: 8,
      emailTemplate: template("OTP for {APP_NAME}", [
        "<p>Your one-time password is: <strong>{OTP}</strong></p>",
        "<p><i>If you didn't ask for the one-time password, you can ignore this email.</i></p>",
      ]),
    },
    authToken: tokenConfig(432000),
    passwordResetToken: tokenConfig(1800),
    emailChangeToken: tokenConfig(1800),
    verificationToken: tokenConfig(86400),
    fileToken: tokenConfig(180),
    verificationTemplate: template("Verify your {APP_NAME} email", [
      "<p>Thank you for joining us at {APP_NAME}.</p>",
      "<p>Click on the button below to verify your email address.</p>",
      "<p>",
      '  <a class="btn" href="{APP_URL}/_/#/auth/confirm-verification/{TOKEN}" target="_blank" rel="noopener">Verify</a>',
      "</p>",
      "<p><i>If you didn't recently register, please ignore this email.</i></p>",
    ]),
    resetPasswordTemplate: template("Reset your {APP_NAME} password", [
      "<p>Click on the button below to reset your password.</p>",
      "<p>",
      '  <a class="btn" href="{APP_URL}/_/#/auth/confirm-password-reset/{TOKEN}" target="_blank" rel="noopener">Reset password</a>',
      "</p>",
      "<p><i>If you didn't ask to reset your password, please ignore this email.</i></p>",
    ]),
    confirmEmailChangeTemplate: template(
      "Confirm your {APP_NAME} new email address",
      [
        "<p>Click on the button below to confirm your new email address.</p>",
        "<p>",
        '  <a class="btn" href="{APP_URL}/_/#/auth/confirm-email-change/{TOKEN}" target="_blank" rel="noopener">Confirm new email</a>',
        "</p>",
        "<p><i>If you didn't ask to change your email address, please ignore this email.</i></p>",
      ],
    ),
  };
}

export function scaffold(
  type: CollectionType,
  name: string,
  id?: string,
): Collection {
  return {
    id: id ?? collectionId(type, name),
    name,
    type,
    system: false,
    fields: type === "view" ? [] : [idField()],
    indexes: [],
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    ...(type === "auth" ? authOptions() : {}),
    ...(type === "view" ? { viewQuery: "" } : {}),
    created: "",
    updated: "",
  };
}

export function superusersScaffold(): Collection {
  const c = scaffold("auth", "_superusers");
  c.system = true;
  c.fields = [idField(), ...authSystemFields(), ...autodateFields(true)];
  c.authToken = tokenConfig(86400);
  return c;
}
