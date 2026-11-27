import type { CollectionModel } from "@heybejs/client";
import type { SettingsModel } from "../settings/use-settings";

const field = (name: string, type: string, extra: object = {}) => ({
  id: `${type}_${name}`,
  name,
  type,
  system: false,
  hidden: false,
  presentable: false,
  required: false,
  ...extra,
});

const idField = {
  id: "text3208210256",
  name: "id",
  type: "text",
  system: true,
  hidden: false,
  presentable: false,
  required: true,
  primaryKey: true,
  autogeneratePattern: "[a-z0-9]{15}",
  min: 15,
  max: 15,
  pattern: "^[a-z0-9]+$",
};

const timestamps = (system = false) => [
  field("created", "autodate", { system, onCreate: true, onUpdate: false }),
  field("updated", "autodate", { system, onCreate: true, onUpdate: true }),
];

const base = {
  system: false,
  listRule: null,
  viewRule: null,
  createRule: null,
  updateRule: null,
  deleteRule: null,
  created: "2026-01-01 00:00:00.000Z",
  updated: "2026-01-01 00:00:00.000Z",
};

const posts: CollectionModel = {
  ...base,
  id: "hbc_posts",
  name: "posts",
  type: "base",
  fields: [
    idField,
    field("title", "text", { required: true }),
    field("views", "number"),
    field("published", "bool"),
    field("contact", "email"),
    field("site", "url"),
    field("body", "editor"),
    field("status", "select", {
      values: ["draft", "live"],
      maxSelect: 1,
    }),
    field("cover", "file", { maxSelect: 1, maxSize: 0, mimeTypes: [] }),
    field("author", "relation", {
      collectionId: "_hb_users_auth_",
      maxSelect: 1,
      cascadeDelete: false,
    }),
    field("meta", "json", { maxSize: 0 }),
    field("place", "geoPoint"),
    field("when", "date"),
    ...timestamps(),
  ],
  indexes: [],
};

const template = (subject: string) => ({ subject, body: `<p>${subject}</p>` });

const authOptions = {
  authRule: "",
  manageRule: null,
  authAlert: { enabled: true, emailTemplate: template("Login alert") },
  oauth2: {
    enabled: true,
    mappedFields: { id: "", name: "", username: "", avatarURL: "" },
    providers: [
      {
        name: "google",
        clientId: "google-id",
        displayName: "",
        pkce: null,
        authURL: "",
        tokenURL: "",
        userInfoURL: "",
        extra: {},
      },
    ],
  },
  passwordAuth: { enabled: true, identityFields: ["email"] },
  mfa: { enabled: false, duration: 1800, rule: "" },
  otp: {
    enabled: false,
    duration: 180,
    length: 8,
    emailTemplate: template("OTP"),
  },
  authToken: { duration: 604800 },
  passwordResetToken: { duration: 1800 },
  emailChangeToken: { duration: 1800 },
  verificationToken: { duration: 259200 },
  fileToken: { duration: 180 },
  verificationTemplate: template("Verify"),
  resetPasswordTemplate: template("Reset"),
  confirmEmailChangeTemplate: template("Confirm email"),
};

const users: CollectionModel = {
  ...base,
  ...authOptions,
  id: "_hb_users_auth_",
  name: "users",
  type: "auth",
  fields: [
    idField,
    field("password", "password", {
      system: true,
      hidden: true,
      required: true,
      min: 8,
    }),
    field("tokenKey", "text", { system: true, hidden: true, required: true }),
    field("email", "email", { system: true, required: true }),
    field("emailVisibility", "bool", { system: true }),
    field("verified", "bool", { system: true }),
    field("name", "text"),
    field("username", "text"),
    field("avatar", "file", {
      maxSelect: 1,
      maxSize: 0,
      thumbs: [],
      protected: false,
      mimeTypes: [
        "image/jpeg",
        "image/png",
        "image/svg+xml",
        "image/gif",
        "image/webp",
      ],
    }),
    ...timestamps(),
  ],
  indexes: [
    "CREATE UNIQUE INDEX `idx_email_users` ON `users` (`email`) WHERE `email` != ''",
    "CREATE UNIQUE INDEX `idx_username_users` ON `users` (`username`)",
  ],
};

const stats: CollectionModel = {
  ...base,
  id: "hbc_stats",
  name: "stats",
  type: "view",
  viewQuery: "SELECT id, title FROM posts",
  fields: [idField, field("title", "text")],
  indexes: [],
};

const superusers: CollectionModel = {
  ...base,
  ...authOptions,
  oauth2: { ...authOptions.oauth2, enabled: false, providers: [] },
  id: "hbc_3142635823",
  name: "_superusers",
  type: "auth",
  system: true,
  fields: [
    idField,
    field("password", "password", {
      system: true,
      hidden: true,
      required: true,
      min: 8,
    }),
    field("tokenKey", "text", { system: true, hidden: true, required: true }),
    field("email", "email", { system: true, required: true }),
    field("emailVisibility", "bool", { system: true }),
    field("verified", "bool", { system: true }),
    ...timestamps(true),
  ],
  indexes: [],
};

export const collectionsFixture: CollectionModel[] = [
  posts,
  stats,
  superusers,
  users,
];

const s3Public = {
  enabled: false,
  bucket: "",
  region: "",
  endpoint: "",
  accessKey: "",
  forcePathStyle: false,
};

export const settingsFixture: SettingsModel = {
  superuserIPs: [],
  meta: {
    accentColor: "#1055c9",
    appName: "Heybe",
    appURL: "http://localhost:8090",
    senderName: "Support",
    senderAddress: "support@example.com",
    hideControls: false,
  },
  logs: {
    maxDataSize: 0,
    maxDays: 7,
    minLevel: 0,
    logIP: true,
    logAuthId: false,
  },
  backups: { cron: "", cronMaxKeep: 3, s3: { ...s3Public } },
  smtp: {
    enabled: false,
    host: "smtp.example.com",
    port: 587,
    username: "",
    authMethod: "",
    tls: false,
    localName: "",
  },
  s3: { ...s3Public },
  batch: { enabled: true, maxRequests: 50, timeout: 3, maxBodySize: 0 },
  rateLimits: { enabled: false, rules: [], excludedIPs: [] },
  trustedProxy: { headers: [], useLeftmostIP: false },
};

const scaffoldBase = {
  id: "",
  name: "",
  system: false,
  indexes: [] as string[],
  listRule: null,
  viewRule: null,
  createRule: null,
  updateRule: null,
  deleteRule: null,
  created: "",
  updated: "",
};

export const scaffoldsFixture: Record<string, CollectionModel> = {
  base: { ...scaffoldBase, type: "base", fields: [{ ...idField, help: "" }] },
  view: { ...scaffoldBase, type: "view", fields: [], viewQuery: "" },
  auth: {
    ...scaffoldBase,
    type: "auth",
    fields: [{ ...idField, help: "" }, ...users.fields.slice(1, 6)],
    indexes: [
      "CREATE UNIQUE INDEX `idx_tokenKey_abc` ON `` (`tokenKey`)",
      "CREATE UNIQUE INDEX `idx_email_abc` ON `` (`email`) WHERE `email` != ''",
    ],
    authRule: "",
    manageRule: null,
  },
};
