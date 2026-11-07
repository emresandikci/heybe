import { findSingleColumnUniqueIndex } from "./ddl";
import {
  type Errors,
  type FieldErr,
  err,
  firstError,
  lengthRule,
  maxRule,
  minRule,
  required,
} from "./errors";
import type { Shape } from "./field-settings";
import type { Collection } from "./model";

const OAUTH2_PROVIDERS = [
  "apple",
  "bitbucket",
  "box",
  "discord",
  "facebook",
  "gitea",
  "gitee",
  "github",
  "gitlab",
  "google",
  "instagram2",
  "kakao",
  "lark",
  "linear",
  "livechat",
  "mailcow",
  "microsoft",
  "monday",
  "notion",
  "oidc",
  "oidc2",
  "oidc3",
  "patreon",
  "planningcenter",
  "spotify",
  "strava",
  "trakt",
  "twitch",
  "twitter",
  "vk",
  "wakatime",
  "yandex",
];

const TOKEN: Shape = { secret: "string", duration: "int" };
const TEMPLATE: Shape = { subject: "string", body: "string" };

export const AUTH_SHAPE: Shape = {
  authRule: "string?",
  manageRule: "string?",
  authAlert: { enabled: "bool", emailTemplate: TEMPLATE },
  oauth2: {
    providers: "providers",
    mappedFields: {
      id: "string",
      name: "string",
      username: "string",
      avatarURL: "string",
    },
    enabled: "bool",
  },
  passwordAuth: { enabled: "bool", identityFields: "strings" },
  mfa: { enabled: "bool", duration: "int", rule: "string" },
  otp: {
    enabled: "bool",
    duration: "int",
    length: "int",
    emailTemplate: TEMPLATE,
  },
  authToken: TOKEN,
  passwordResetToken: TOKEN,
  emailChangeToken: TOKEN,
  verificationToken: TOKEN,
  fileToken: TOKEN,
  verificationTemplate: TEMPLATE,
  resetPasswordTemplate: TEMPLATE,
  confirmEmailChangeTemplate: TEMPLATE,
};

export const AUTH_KEYS = Object.keys(AUTH_SHAPE);
export const TOKEN_KEYS = [
  "authToken",
  "passwordResetToken",
  "emailChangeToken",
  "verificationToken",
  "fileToken",
] as const;

type Obj = Record<string, unknown>;

export type RuleCheck = (value: unknown, old: unknown) => FieldErr | null;

const blank = (v: unknown) => v === "" || v === undefined || v === null;

function template(t: Obj): Errors | null {
  const out: Errors = {};
  if (blank(t.subject)) out.subject = err(required);
  if (blank(t.body)) out.body = err(required);
  return Object.keys(out).length > 0 ? out : null;
}

function between(value: number, min: number, max: number): FieldErr | null {
  if (value === 0) return err(required);
  if (value < min) return minRule(min);
  if (value > max) return maxRule(max);
  return null;
}

function token(t: Obj): Errors | null {
  const out: Errors = {};
  const secret = String(t.secret ?? "");
  if (secret === "") out.secret = err(required);
  else if (secret.length < 30 || secret.length > 255)
    out.secret = lengthRule(30, 255);
  const duration = between(Number(t.duration), 10, 94670856);
  if (duration) out.duration = duration;
  return Object.keys(out).length > 0 ? out : null;
}

function whenEnabled(
  enabled: boolean,
  value: number,
  min: number,
  max?: number,
): FieldErr | null {
  if (!enabled) return null;
  return max === undefined
    ? firstError(
        value === 0 ? err(required) : null,
        value < min ? minRule(min) : null,
      )
    : between(value, min, max);
}

export function validateAuthOptions(
  next: Collection,
  old: Collection | null,
  ruleCheck: RuleCheck,
): Errors {
  const errors: Errors = {};
  const set = (path: string[], e: FieldErr | Errors | null) => {
    if (!e) return;
    let node = errors;
    for (const key of path.slice(0, -1)) node = (node[key] ??= {}) as Errors;
    node[path.at(-1)!] = e;
  };
  const o = next as unknown as Record<string, Obj>;
  const mfa = o.mfa!;
  const otp = o.otp!;
  const oauth2 = o.oauth2!;
  const passwordAuth = o.passwordAuth!;

  set(["authRule"], ruleCheck(next.authRule, old?.authRule));
  set(
    ["manageRule"],
    firstError(
      next.manageRule === ""
        ? err(["validation_nil_or_not_empty_required", "Cannot be blank."])
        : null,
      ruleCheck(next.manageRule, old?.manageRule),
    ),
  );
  set(
    ["authAlert", "emailTemplate"],
    template(o.authAlert!.emailTemplate as Obj),
  );
  if (
    passwordAuth.enabled === true &&
    (passwordAuth.identityFields as string[]).length === 0
  )
    set(["passwordAuth", "identityFields"], err(required));
  if (oauth2.enabled === true) {
    const providers = oauth2.providers as Obj[];
    const names = providers.map((p) => String(p.name ?? ""));
    const dup = names.findIndex((n, i) => n !== "" && names.indexOf(n) < i);
    if (dup >= 0) {
      const name = names[dup]!;
      set(
        ["oauth2", "providers", String(dup), "name"],
        err(
          [
            "validation_duplicated_provider",
            `The provider ${name} is already registered.`,
          ],
          { name },
        ),
      );
    } else {
      providers.forEach((p, i) => {
        const at = (key: string) => ["oauth2", "providers", String(i), key];
        const name = names[i]!;
        if (name === "") set(at("name"), err(required));
        else if (!OAUTH2_PROVIDERS.includes(name))
          set(
            at("name"),
            err(
              [
                "validation_missing_provider",
                `Invalid or missing provider with name ${name}.`,
              ],
              { name },
            ),
          );
        if (blank(p.clientId)) set(at("clientId"), err(required));
        if (blank(p.clientSecret)) set(at("clientSecret"), err(required));
        for (const key of ["authURL", "tokenURL", "userInfoURL"])
          if (
            typeof p[key] === "string" &&
            p[key] !== "" &&
            !URL.canParse(p[key])
          )
            set(at(key), err(["validation_is_url", "Must be a valid URL."]));
      });
    }
  }
  set(
    ["otp", "duration"],
    whenEnabled(otp.enabled === true, Number(otp.duration), 10, 86400),
  );
  set(
    ["otp", "length"],
    whenEnabled(otp.enabled === true, Number(otp.length), 4),
  );
  set(["otp", "emailTemplate"], template(otp.emailTemplate as Obj));
  set(
    ["mfa", "duration"],
    whenEnabled(mfa.enabled === true, Number(mfa.duration), 10, 86400),
  );
  for (const key of TOKEN_KEYS) set([key], token(o[key]!));
  for (const key of [
    "verificationTemplate",
    "resetPasswordTemplate",
    "confirmEmailChangeTemplate",
  ])
    set([key], template(o[key]!));
  if (Object.keys(errors).length > 0) return errors;

  if (mfa.enabled === true) {
    const methods = [passwordAuth.enabled, oauth2.enabled, otp.enabled].filter(
      (v) => v === true,
    ).length;
    if (methods < 2) {
      set(
        ["mfa", "enabled"],
        err([
          "validation_mfa_not_enough_auths",
          "MFA requires at least 2 auth methods to be enabled.",
        ]),
      );
      return errors;
    }
    if (mfa.rule !== "") {
      const oldRule = (old as unknown as Record<string, Obj> | null)?.mfa?.rule;
      const e = ruleCheck(mfa.rule, oldRule);
      if (e) {
        set(["mfa", "rule"], e);
        return errors;
      }
    }
  }

  if (passwordAuth.enabled === true) {
    for (const name of [...new Set(passwordAuth.identityFields as string[])]) {
      const fieldName = name;
      if (!next.fields.some((f) => f.name === name))
        return fail(
          errors,
          err(
            ["validation_missing_field", `Invalid or missing field ${name}.`],
            { fieldName },
          ),
        );
      if (!findSingleColumnUniqueIndex(next.indexes, name))
        return fail(
          errors,
          err(
            [
              "validation_missing_unique_constraint",
              `The field ${name} doesn't have a UNIQUE constraint.`,
            ],
            { fieldName },
          ),
        );
    }
  }
  return errors;
}

function fail(errors: Errors, e: FieldErr): Errors {
  errors.passwordAuth = { identityFields: e };
  return errors;
}
