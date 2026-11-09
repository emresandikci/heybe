import { isIP } from "node:net";
import {
  type Errors,
  type FieldErr,
  atLeast,
  atMost,
  err,
  invalidFormat,
  lengthRule,
  required,
} from "./collections/errors";
import type { App } from "./app";
import type { Db } from "./db";
import { SettingsReloadEvent } from "./hooks/events";
import { isEmail } from "./fields/email";
import { isUrl } from "./fields/url";
import { isIpOrSubnet } from "./ip";
import { ValidationError } from "./util";

export interface RateLimitRule {
  label: string;
  audience: string;
  duration: number;
  maxRequests: number;
}

export interface S3Config {
  enabled: boolean;
  bucket: string;
  region: string;
  endpoint: string;
  accessKey: string;
  secret: string;
  forcePathStyle: boolean;
}

export interface SettingsData {
  superuserIPs: string[];
  smtp: {
    enabled: boolean;
    port: number;
    host: string;
    username: string;
    password: string;
    authMethod: string;
    tls: boolean;
    localName: string;
  };
  backups: {
    cron: string;
    cronMaxKeep: number;
    s3: S3Config;
  };
  s3: S3Config;
  meta: {
    accentColor: string;
    appName: string;
    appURL: string;
    senderName: string;
    senderAddress: string;
    hideControls: boolean;
  };
  rateLimits: {
    rules: RateLimitRule[];
    excludedIPs: string[];
    enabled: boolean;
  };
  trustedProxy: { headers: string[]; useLeftmostIP: boolean };
  batch: {
    enabled: boolean;
    maxRequests: number;
    timeout: number;
    maxBodySize: number;
  };
  logs: {
    maxDataSize: number;
    maxDays: number;
    minLevel: number;
    logIP: boolean;
    logAuthId: boolean;
  };
}

type Schema = { [key: string]: Node };
type Node = "bool" | "string" | "int" | "strings" | Schema | readonly [Schema];

const S3_SCHEMA: Schema = {
  enabled: "bool",
  bucket: "string",
  region: "string",
  endpoint: "string",
  accessKey: "string",
  secret: "string",
  forcePathStyle: "bool",
};

const SCHEMA: Schema = {
  superuserIPs: "strings",
  smtp: {
    enabled: "bool",
    port: "int",
    host: "string",
    username: "string",
    password: "string",
    authMethod: "string",
    tls: "bool",
    localName: "string",
  },
  backups: { cron: "string", cronMaxKeep: "int", s3: S3_SCHEMA },
  s3: S3_SCHEMA,
  meta: {
    accentColor: "string",
    appName: "string",
    appURL: "string",
    senderName: "string",
    senderAddress: "string",
    hideControls: "bool",
  },
  rateLimits: {
    rules: [
      {
        label: "string",
        audience: "string",
        duration: "int",
        maxRequests: "int",
      },
    ],
    excludedIPs: "strings",
    enabled: "bool",
  },
  trustedProxy: { headers: "strings", useLeftmostIP: "bool" },
  batch: {
    enabled: "bool",
    maxRequests: "int",
    timeout: "int",
    maxBodySize: "int",
  },
  logs: {
    maxDataSize: "int",
    maxDays: "int",
    minLevel: "int",
    logIP: "bool",
    logAuthId: "bool",
  },
};

const DEFAULTS: SettingsData = {
  superuserIPs: [],
  smtp: {
    enabled: false,
    port: 587,
    host: "smtp.example.com",
    username: "",
    password: "",
    authMethod: "",
    tls: false,
    localName: "",
  },
  backups: {
    cron: "",
    cronMaxKeep: 3,
    s3: zero(S3_SCHEMA) as unknown as S3Config,
  },
  s3: zero(S3_SCHEMA) as unknown as S3Config,
  meta: {
    accentColor: "#1055c9",
    appName: "Acme",
    appURL: "http://localhost:8090",
    senderName: "Support",
    senderAddress: "support@example.com",
    hideControls: false,
  },
  rateLimits: {
    rules: [
      { label: "*:auth", audience: "", duration: 3, maxRequests: 2 },
      { label: "*:create", audience: "", duration: 5, maxRequests: 20 },
      { label: "/api/batch", audience: "", duration: 1, maxRequests: 3 },
      { label: "/api/", audience: "", duration: 10, maxRequests: 300 },
    ],
    excludedIPs: [],
    enabled: false,
  },
  trustedProxy: { headers: [], useLeftmostIP: false },
  batch: { enabled: false, maxRequests: 50, timeout: 3, maxBodySize: 0 },
  logs: {
    maxDataSize: 0,
    maxDays: 5,
    minLevel: 0,
    logIP: true,
    logAuthId: false,
  },
};

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>;
};

export class SettingsLoadError extends Error {}

function zero(node: Node): unknown {
  if (node === "bool") return false;
  if (node === "string") return "";
  if (node === "int") return 0;
  if (node === "strings" || Array.isArray(node)) return [];
  return Object.fromEntries(
    Object.entries(node as Schema).map(([k, n]) => [k, zero(n)]),
  );
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function merge(node: Node, value: unknown, current: unknown): unknown {
  if (value === null) return zero(node);
  if (node === "bool" || node === "string") {
    if (typeof value !== (node === "bool" ? "boolean" : "string"))
      throw new SettingsLoadError();
    return value;
  }
  if (node === "int") {
    if (!Number.isInteger(value) || Math.abs(value as number) >= 2 ** 63)
      throw new SettingsLoadError();
    return value;
  }
  if (node === "strings") {
    if (!Array.isArray(value)) throw new SettingsLoadError();
    return value.map((v) => merge("string", v, ""));
  }
  if (Array.isArray(node)) {
    if (!Array.isArray(value)) throw new SettingsLoadError();
    return value.map((v) => merge(node[0], v, zero(node[0])));
  }
  if (!isObject(value)) throw new SettingsLoadError();
  const schema = node as Schema;
  const out = { ...(current as Record<string, unknown>) };
  for (const [key, v] of Object.entries(value)) {
    const lower = key.toLowerCase();
    const field = Object.hasOwn(schema, key)
      ? key
      : Object.keys(schema).find((k) => k.toLowerCase() === lower);
    if (field) out[field] = merge(schema[field], v, out[field]);
  }
  return out;
}

type Check = (value: any) => unknown;

const first =
  (...checks: Check[]): Check =>
  (value) => {
    for (const check of checks) {
      const result = check(value);
      if (result) return result;
    }
    return null;
  };

const isEmpty = (v: unknown) =>
  v === "" || v === 0 || v === false || (Array.isArray(v) && v.length === 0);

const req: Check = (v) => (isEmpty(v) ? err(required) : null);
const when = (cond: boolean, check: Check): Check =>
  cond ? check : () => null;
const optional =
  (check: (v: string) => FieldErr | null): Check =>
  (v) =>
    v === "" ? null : check(v);

const urlCheck = optional((v) =>
  isUrl(v) ? null : err(["validation_is_url", "Must be a valid URL."]),
);
const emailCheck = optional((v) =>
  isEmail(v)
    ? null
    : err(["validation_is_email", "Must be a valid email address."]),
);
const hexColorCheck = optional((v) =>
  /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)
    ? null
    : err([
        "validation_is_hex_color",
        "Must be a valid hexadecimal color code.",
      ]),
);
const DNS_NAME =
  /^([a-zA-Z0-9_]{1}[a-zA-Z0-9_-]{0,62}){1}(\.[a-zA-Z0-9_]{1}[a-zA-Z0-9_-]{0,62})*[._]?$/;
const hostCheck = optional((v) =>
  isIP(v) !== 0 || (v.replaceAll(".", "").length <= 255 && DNS_NAME.test(v))
    ? null
    : err(["validation_is_host", "Must be a valid IP address or DNS name."]),
);
const ipCheck = optional((v) =>
  isIpOrSubnet(v)
    ? null
    : err(["validation_invlaid_ip_or_subnet", "Invalid IP or CIDR subnet."]),
);
const inCheck = (...options: string[]) =>
  optional((v) =>
    options.includes(v)
      ? null
      : err(["validation_in_invalid", "Must be a valid value."]),
  );
const lengthCheck = (min: number, max: number) =>
  optional((v) => {
    const length = [...v].length;
    if (length >= min && length <= max) return null;
    if (min === max)
      return err(
        ["validation_length_invalid", `The length must be exactly ${min}.`],
        { min, max },
      );
    return lengthRule(min, max);
  });
const matchCheck = (re: RegExp) =>
  optional((v) => (re.test(v) ? null : err(invalidFormat)));
const min =
  (n: number): Check =>
  (v) =>
    atLeast(v, n);
const max =
  (n: number): Check =>
  (v) =>
    atMost(v, n);

const each =
  (check: Check): Check =>
  (list: unknown[]) => {
    const errors: Errors = {};
    list.forEach((item, i) => {
      const result = check(item);
      if (result) errors[String(i)] = result;
    });
    return Object.keys(errors).length > 0 ? errors : null;
  };

const MAX_SAFE_JSON_INT = 2 ** 53 - 1;
const ipList = each(first(req, ipCheck));
const RULE_LABEL = /^(\w+ \/[\w/-]*|\/[\w/-]*|\w+:\w+|\*:\w+|\w+)$/;

function atoi(s: string): number | string {
  if (!/^[+-]?\d+$/.test(s))
    return `strconv.Atoi: parsing "${s}": invalid syntax`;
  const n = Number(s);
  return Number.isSafeInteger(n)
    ? n
    : `strconv.Atoi: parsing "${s}": value out of range`;
}

function cronSegment(segment: string, lo: number, hi: number): string | null {
  for (const part of segment.split(",")) {
    const stepParts = part.split("/");
    let step = 1;
    if (stepParts.length === 2) {
      const parsed = atoi(stepParts[1]);
      if (typeof parsed === "string") return parsed;
      if (parsed < 1 || parsed > hi)
        return `invalid segment step boundary - the step must be between 1 and the ${hi}`;
      step = parsed;
    } else if (stepParts.length > 2) {
      return "invalid segment step format - must be in the format */n or 1-30/n";
    }
    if (stepParts[0] === "*") continue;
    const range = stepParts[0].split("-");
    if (range.length === 1) {
      if (step !== 1)
        return "invalid segment step - step > 1 could be used only with the wildcard or range format";
      const parsed = atoi(range[0]);
      if (typeof parsed === "string") return parsed;
      if (parsed < lo || parsed > hi)
        return "invalid segment value - must be between the min and max of the segment";
    } else if (range.length === 2) {
      const from = atoi(range[0]);
      if (typeof from === "string") return from;
      if (from < lo || from > hi)
        return `invalid segment range minimum - must be between ${lo} and ${hi}`;
      const to = atoi(range[1]);
      if (typeof to === "string") return to;
      if (to < from || to > hi)
        return `invalid segment range maximum - must be between ${from} and ${hi}`;
    } else {
      return "invalid segment range format - the range must have 1 or 2 parts";
    }
  }
  return null;
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const BOUNDS: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

const cronCheck = optional((expr) => {
  const segments = (MACROS[expr] ?? expr).split(" ");
  let message: string | null = null;
  if (segments.length !== 5)
    message =
      "invalid cron expression - must be a valid macro or to have exactly 5 space separated segments";
  else
    for (let i = 0; i < 5 && message === null; i++)
      message = cronSegment(segments[i], BOUNDS[i][0], BOUNDS[i][1]);
  return message === null ? null : err(["validation_invalid_cron", message]);
});

function uniqueRuleLabels(rules: RateLimitRule[]): unknown {
  const existing: string[] = [];
  for (const [i, rule] of rules.entries()) {
    const key = `${rule.label}@@${rule.audience}`;
    if (existing.some((k) => k.startsWith(key) || key.startsWith(k)))
      return {
        [i]: {
          label: err(
            [
              "validation_conflicting_rate_limit_rule",
              `Rate limit rule configuration with label ${rule.label} already exists or conflicts with another rule.`,
            ],
            { label: rule.label },
          ),
        },
      };
    existing.push(key);
  }
  return null;
}

function fields(
  entries: Record<string, unknown>,
): Record<string, unknown> | null {
  const out = Object.fromEntries(
    Object.entries(entries).filter(([, v]) => v !== null),
  );
  return Object.keys(out).length > 0 ? out : null;
}

function validateS3(c: S3Config) {
  return fields({
    endpoint: first(urlCheck, when(c.enabled, req))(c.endpoint),
    bucket: when(c.enabled, req)(c.bucket),
    region: when(c.enabled, req)(c.region),
    accessKey: when(c.enabled, req)(c.accessKey),
    secret: when(c.enabled, req)(c.secret),
  });
}

function validateRule(r: RateLimitRule) {
  return fields({
    label: first(req, matchCheck(RULE_LABEL))(r.label),
    maxRequests: first(req, min(1))(r.maxRequests),
    duration: first(req, min(1))(r.duration),
    audience: inCheck("", "@guest", "@auth")(r.audience),
  });
}

function validateRules(c: SettingsData["rateLimits"]) {
  const rules = first(when(c.enabled, req), uniqueRuleLabels as Check)(c.rules);
  if (rules) return rules;
  const elements: Errors = {};
  c.rules.forEach((rule, i) => {
    const result = validateRule(rule);
    if (result) elements[String(i)] = result;
  });
  return Object.keys(elements).length > 0 ? elements : null;
}

function validate(s: SettingsData): Errors | null {
  const { smtp, backups, meta, rateLimits, batch, logs } = s;
  const errors = fields({
    superuserIPs: ipList(s.superuserIPs),
    meta: fields({
      accentColor: first(lengthCheck(7, 7), hexColorCheck)(meta.accentColor),
      appName: first(req, lengthCheck(1, 255))(meta.appName),
      appURL: first(req, urlCheck)(meta.appURL),
      senderName: first(req, lengthCheck(1, 255))(meta.senderName),
      senderAddress: first(emailCheck, req)(meta.senderAddress),
    }),
    logs: fields({
      maxDataSize: first(min(0), max(MAX_SAFE_JSON_INT))(logs.maxDataSize),
      maxDays: first(min(0), max(MAX_SAFE_JSON_INT))(logs.maxDays),
      minLevel: max(MAX_SAFE_JSON_INT)(logs.minLevel),
    }),
    smtp: fields({
      host: first(when(smtp.enabled, req), hostCheck)(smtp.host),
      port: first(when(smtp.enabled, req), min(0))(smtp.port),
      authMethod: inCheck("LOGIN", "PLAIN")(smtp.authMethod),
      localName: hostCheck(smtp.localName),
    }),
    s3: validateS3(s.s3),
    backups: fields({
      s3: validateS3(backups.s3),
      cron: cronCheck(backups.cron),
      cronMaxKeep: first(
        when(backups.cron !== "", req),
        min(1),
      )(backups.cronMaxKeep),
    }),
    batch: fields({
      maxRequests: first(when(batch.enabled, req), min(0))(batch.maxRequests),
      timeout: first(when(batch.enabled, req), min(0))(batch.timeout),
      maxBodySize: min(0)(batch.maxBodySize),
    }),
    rateLimits: fields({
      rules: validateRules(rateLimits),
      excludedIPs: ipList(rateLimits.excludedIPs),
    }),
  });
  return errors as Errors | null;
}

// PB Settings.MarshalJSON: the secrets are left out.
export function publicSettings(data: SettingsData): object {
  const { smtp, s3, backups, ...rest } = data;
  const { password: _smtp, ...smtpPublic } = smtp;
  const { secret: _s3, ...s3Public } = s3;
  const { secret: _backups, ...backupsS3Public } = backups.s3;
  return {
    ...rest,
    smtp: smtpPublic,
    s3: s3Public,
    backups: { ...backups, s3: backupsS3Public },
  };
}

export class Settings {
  private cached: SettingsData | null = null;
  app?: App;

  constructor(private readonly db: Db) {}

  // The cached settings without a copy, for hot paths: callers must not modify them.
  current(): Readonly<SettingsData> {
    return (this.cached ??= this.db.committed(() => this.load()));
  }

  get(): SettingsData {
    this.cached ??= this.db.committed(() => this.load());
    return structuredClone(this.cached);
  }

  // PB ReloadSettings: onSettingsReload around loading the stored settings, so its handlers see the
  // old settings before next() and the new ones after.
  reload(): Promise<void> {
    return this.reloadWith(null);
  }

  private async reloadWith(next: SettingsData | null): Promise<void> {
    const apply = () => {
      this.cached = next;
    };
    const hook = this.app?.hooks.onSettingsReload;
    if (!hook || hook.length === 0) return apply();
    await hook.trigger(SettingsReloadEvent.of({ app: this.app! }), apply);
  }

  private load(): SettingsData {
    const row = this.db.get<{ value: string }>(
      "SELECT value FROM _params WHERE key = 'settings'",
    );
    return merge(
      SCHEMA,
      row ? JSON.parse(row.value) : {},
      DEFAULTS,
    ) as SettingsData;
  }

  // The current settings with `patch` loaded into them, not saved (PB BindBody on a settings clone).
  bind(patch: DeepPartial<SettingsData>): SettingsData {
    return merge(SCHEMA, patch, this.get()) as SettingsData;
  }

  update(patch: DeepPartial<SettingsData>): Promise<SettingsData> {
    return this.write(() => merge(SCHEMA, patch, this.load()) as SettingsData);
  }

  save(data: SettingsData): Promise<SettingsData> {
    return this.write(() => data);
  }

  // onSettingsReload runs once the write committed
  private async write(build: () => SettingsData): Promise<SettingsData> {
    this.get();
    let reloaded: Promise<void> | undefined;
    const next = await this.db.write(() => {
      const next = build();
      const errors = validate(next);
      if (errors)
        throw new ValidationError(
          "An error occurred while saving the new settings.",
          errors,
        );
      this.db.run(
        "INSERT INTO _params (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [JSON.stringify(next)],
      );
      this.db.onComplete((err) => {
        if (err !== null) this.cached = null;
        else reloaded = this.reloadWith(structuredClone(next));
        return reloaded;
      });
      return next;
    });
    await reloaded;
    return structuredClone(next);
  }

  toJSON(): object {
    return publicSettings(this.get());
  }
}
