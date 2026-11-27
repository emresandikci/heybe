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

const OWNER_RULE =
  "@request.auth.id != '' && recordRef = @request.auth.id && collectionRef = @request.auth.collectionId";

function systemBase(
  name: string,
  fields: Field[],
  indexes: string[],
  rules: Partial<Collection> = {},
): Collection {
  return {
    ...scaffold("base", name),
    system: true,
    fields: [idField(), ...fields, ...autodateFields(true)],
    indexes,
    listRule: OWNER_RULE,
    viewRule: OWNER_RULE,
    ...rules,
  };
}

const ref = (name: string, options: Record<string, unknown> = {}) =>
  field("text", name, { system: true, required: true, ...options });

export function usersScaffold(): Collection {
  const c = scaffold("auth", "users", "_hb_users_auth_");
  c.listRule = "id = @request.auth.id";
  c.viewRule = "id = @request.auth.id";
  c.createRule = "";
  c.updateRule = "id = @request.auth.id";
  c.deleteRule = "id = @request.auth.id";
  c.fields = [
    idField(),
    ...authSystemFields(),
    field("text", "name", { max: 255 }),
    field("file", "avatar", {
      maxSelect: 1,
      mimeTypes: [
        "image/jpeg",
        "image/png",
        "image/svg+xml",
        "image/gif",
        "image/webp",
      ],
    }),
    ...autodateFields(false),
  ];
  const oauth2 = c.oauth2 as { mappedFields: Record<string, string> };
  oauth2.mappedFields.name = "name";
  oauth2.mappedFields.avatarURL = "avatar";
  return c;
}

// The system collections of a fresh data directory, in creation order.
export function bootstrapCollections(): Collection[] {
  return [
    systemBase(
      "_mfas",
      [ref("collectionRef"), ref("recordRef"), ref("method")],
      [
        "CREATE INDEX `idx_mfas_collectionRef_recordRef` ON `_mfas` (collectionRef,recordRef)",
      ],
    ),
    systemBase(
      "_otps",
      [
        ref("collectionRef"),
        ref("recordRef"),
        field("password", "password", {
          system: true,
          hidden: true,
          required: true,
          cost: 8,
        }),
        field("text", "sentTo", { system: true, hidden: true }),
      ],
      [
        "CREATE INDEX `idx_otps_collectionRef_recordRef` ON `_otps` (collectionRef, recordRef)",
      ],
    ),
    systemBase(
      "_externalAuths",
      [
        ref("collectionRef"),
        ref("recordRef"),
        ref("provider"),
        ref("providerId"),
      ],
      [
        "CREATE UNIQUE INDEX `idx_externalAuths_record_provider` ON `_externalAuths` (collectionRef, recordRef, provider)",
        "CREATE UNIQUE INDEX `idx_externalAuths_collection_provider` ON `_externalAuths` (collectionRef, provider, providerId)",
      ],
      { deleteRule: OWNER_RULE },
    ),
    systemBase(
      "_authOrigins",
      [ref("collectionRef"), ref("recordRef"), ref("fingerprint")],
      [
        "CREATE UNIQUE INDEX `idx_authOrigins_unique_pairs` ON `_authOrigins` (collectionRef, recordRef, fingerprint)",
      ],
      { deleteRule: OWNER_RULE },
    ),
    superusersScaffold(),
    usersScaffold(),
  ];
}
