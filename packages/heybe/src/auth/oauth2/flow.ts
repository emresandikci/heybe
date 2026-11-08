import { lookup } from "node:dns/promises";
import { type IncomingMessage, get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { BlockList, type LookupFunction, isIP } from "node:net";
import type { App } from "../../app";
import { findSingleColumnUniqueIndex, quote } from "../../collections/ddl";
import type { Collection } from "../../collections/model";
import { fields } from "../../fields";
import type { RequestInfo } from "../../filter/compile";
import { ApiError, logUnexpected } from "../../http/errors";
import { DEFAULT_MAX_BODY_SIZE } from "../../http/middlewares";
import type { AuthState } from "../../http/router";
import { createPreparedChecked } from "../../http/routes/records";
import { PasswordValue } from "../../fields/password";
import type { PreparedWrite } from "../../records/service";
import { ValidationError, formatDate, randomSecret } from "../../util";
import { findAuthRecordByEmail, randomPassword } from "../flows";
import { readText } from "./http";
import { parseUnverified, validateClaims, validateTokenSignature } from "./jwk";
import { mappers } from "./mappers";
import { type ProviderInfo, providers } from "./providers";
import { internalRecords } from "../../records/internal";

type Values = Record<string, unknown>;

export interface AuthUser {
  id: string;
  name: string;
  username: string;
  email: string;
  avatarURL: string;
  accessToken: string;
  refreshToken: string;
  expiry: string;
  rawUser: Record<string, unknown>;
}

export interface OAuth2Token {
  accessToken: string;
  tokenType: string;
  refreshToken: string;
  expiry: Date | null;
  raw: Record<string, unknown>;
}

// A provider with a collection's config applied (PB OAuth2ProviderConfig.InitProvider).
export interface Provider extends ProviderInfo {
  clientId: string;
  clientSecret: string;
  extra: Record<string, unknown>;
}

export interface FetchCtx {
  app: App;
  signal: AbortSignal;
}

// Loads the provider's user.
export type UserFetcher = (
  p: Provider,
  token: OAuth2Token,
  ctx: FetchCtx,
) => Promise<AuthUser>;

export interface OAuth2Input {
  provider: string;
  code: string;
  codeVerifier: string;
  redirectURL: string;
  createData?: Record<string, unknown>;
}

// x/oauth2 caps token responses at 1 MiB
const MAX_TOKEN_RESPONSE = 1 << 20;
const PROVIDER_TIMEOUT_MS = 30_000;
const AVATAR_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 10;
const ID_TOKEN_LEEWAY_MS = 5 * 60_000;

export const isObject = (v: unknown): v is Values =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export function providerConfigs(c: Collection): Values[] {
  return (c.oauth2 as { providers: Values[] }).providers;
}

export function initProvider(config: Values): Provider | null {
  const info = providers[String(config.name)];
  if (!info) return null;
  const p: Provider = {
    ...info,
    scopes: [...info.scopes],
    clientId: "",
    clientSecret: "",
    extra: {},
  };
  for (const key of [
    "clientId",
    "clientSecret",
    "authURL",
    "tokenURL",
    "userInfoURL",
    "displayName",
  ] as const)
    if (typeof config[key] === "string" && config[key] !== "")
      p[key] = config[key];
  if (typeof config.pkce === "boolean") p.pkce = config.pkce;
  if (isObject(config.extra)) p.extra = config.extra;
  if (
    p.name === "microsoft" &&
    castString(p.extra.idTokenEmailClaim) !== "" &&
    !p.scopes.includes("openid")
  )
    p.scopes.push("openid");
  return p;
}

// cast.ToString for the scalar types
export const castString = (v: unknown) =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean"
    ? String(v)
    : "";

// Go url.QueryEscape
const queryEscape = (s: string) =>
  encodeURIComponent(s)
    .replace(
      /[!'()*]/g,
      (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    .replace(/%20/g, "+");

// Go url.Values.Encode: sorted by key
const encodeValues = (v: Record<string, string>) =>
  Object.keys(v)
    .sort()
    .map((k) => `${queryEscape(k)}=${queryEscape(v[k]!)}`)
    .join("&");

// x/oauth2 Config.AuthCodeURL
export function buildAuthURL(
  p: Provider,
  state: string,
  params: Record<string, string>,
): string {
  const v: Record<string, string> = {
    response_type: "code",
    client_id: p.clientId,
  };
  if (p.scopes.length > 0) v.scope = p.scopes.join(" ");
  if (state !== "") v.state = state;
  Object.assign(v, params);
  return `${p.authURL}${p.authURL.includes("?") ? "&" : "?"}${encodeValues(v)}`;
}

const s256 = (verifier: string) =>
  new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");

// The `oauth2.providers` list of PB recordAuthMethods.
export function authMethodsProviders(c: Collection): Values[] {
  const out: Values[] = [];
  for (const config of providerConfigs(c)) {
    const p = initProvider(config);
    if (!p) continue;
    const params: Record<string, string> = {};
    if (p.name === "apple") params.response_mode = "form_post";
    const info = {
      name: config.name,
      displayName: p.displayName || config.name,
      logo: p.logo,
      state: randomSecret(30),
      authURL: "",
      authUrl: "",
      codeVerifier: "",
      codeChallenge: "",
      codeChallengeMethod: "",
    };
    if (p.pkce) {
      info.codeVerifier = randomSecret(43);
      info.codeChallenge = s256(info.codeVerifier);
      info.codeChallengeMethod = "S256";
      params.code_challenge = info.codeChallenge;
      params.code_challenge_method = info.codeChallengeMethod;
    }
    // empty redirect_uri so that the client can append its own
    info.authURL = `${buildAuthURL(p, info.state, params)}&redirect_uri=`;
    info.authUrl = info.authURL;
    out.push(info);
  }
  return out;
}

export function typed(raw: Values, key: string, type: "string"): string;
export function typed(raw: Values, key: string, type: "number"): number;
export function typed(raw: Values, key: string, type: "boolean"): boolean;
// Go json.Unmarshal into a typed struct field: null or missing is the zero value, another type fails.
export function typed(
  raw: Values,
  key: string,
  type: "string" | "number" | "boolean",
) {
  const v = raw[key];
  if (v === undefined || v === null)
    return type === "string" ? "" : type === "number" ? 0 : false;
  if (typeof v !== type) throw new Error(`invalid ${key} value`);
  return v;
}

export function parseObject(text: string): Values {
  const v = JSON.parse(text);
  if (v === null) return {};
  if (!isObject(v)) throw new Error("expected a JSON object");
  return v;
}

// cast.ToBool
export function castBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string")
    return ["1", "t", "T", "TRUE", "true", "True"].includes(v);
  return false;
}

// x/oauth2 Token.Type
export function authorization(token: OAuth2Token): string {
  const t = token.tokenType;
  const type =
    t.toLowerCase() === "bearer" || t === ""
      ? "Bearer"
      : t.toLowerCase() === "mac"
        ? "MAC"
        : t.toLowerCase() === "basic"
          ? "Basic"
          : t;
  return `${type} ${token.accessToken}`;
}

function parseToken(app: App, res: Response, text: string): OAuth2Token {
  const type = (res.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  let raw: Values;
  let expiresIn: number;
  if (type === "application/x-www-form-urlencoded" || type === "text/plain") {
    const vals = new URLSearchParams(text);
    raw = {};
    for (const [k, v] of vals) raw[k] ??= v;
    expiresIn = Number.parseInt(vals.get("expires_in") ?? "", 10) || 0;
  } else {
    raw = parseObject(text);
    const e = raw.expires_in;
    expiresIn =
      typeof e === "number"
        ? Math.trunc(e)
        : typeof e === "string" && e !== ""
          ? Number.parseInt(e, 10)
          : 0;
    if (Number.isNaN(expiresIn)) throw new Error("invalid expires_in");
  }
  const str = (k: string) => {
    const v = raw[k];
    if (v === undefined || v === null) return "";
    if (typeof v !== "string") throw new Error(`invalid ${k}`);
    return v;
  };
  const token: OAuth2Token = {
    accessToken: str("access_token"),
    tokenType: str("token_type"),
    refreshToken: str("refresh_token"),
    expiry:
      expiresIn !== 0 ? new Date(app.now().getTime() + expiresIn * 1000) : null,
    raw,
  };
  if (token.accessToken === "")
    throw new Error("oauth2: server response missing access_token");
  return token;
}

type AuthStyle = "header" | "params";
// like x/oauth2, the client auth style that worked per token URL
const authStyles = new Map<string, AuthStyle>();

async function tokenRoundTrip(
  app: App,
  p: Provider,
  values: Record<string, string>,
  style: AuthStyle,
  signal: AbortSignal,
): Promise<OAuth2Token> {
  const body = { ...values };
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (style === "params") {
    if (p.clientId !== "") body.client_id = p.clientId;
    if (p.clientSecret !== "") body.client_secret = p.clientSecret;
  } else {
    headers.authorization = `Basic ${btoa(`${queryEscape(p.clientId)}:${queryEscape(p.clientSecret)}`)}`;
  }
  const res = await fetch(p.tokenURL, {
    method: "POST",
    headers,
    body: encodeValues(body),
    signal,
  });
  const text = await readText(res, MAX_TOKEN_RESPONSE);
  if (res.status < 200 || res.status > 299)
    throw new Error(`oauth2: cannot fetch token: ${res.status}`);
  return parseToken(app, res, text);
}

// x/oauth2 Config.Exchange with AuthStyleAutoDetect
export async function fetchToken(
  app: App,
  p: Provider,
  input: Pick<OAuth2Input, "code" | "codeVerifier" | "redirectURL">,
  signal: AbortSignal,
): Promise<OAuth2Token> {
  const values: Record<string, string> = {
    grant_type: "authorization_code",
    code: input.code,
  };
  if (input.redirectURL !== "") values.redirect_uri = input.redirectURL;
  if (p.pkce) values.code_verifier = input.codeVerifier;
  const known = authStyles.get(p.tokenURL);
  if (known) return tokenRoundTrip(app, p, values, known, signal);
  let token: OAuth2Token;
  let style: AuthStyle = "header";
  try {
    token = await tokenRoundTrip(app, p, values, style, signal);
  } catch {
    style = "params";
    token = await tokenRoundTrip(app, p, values, style, signal);
  }
  authStyles.set(p.tokenURL, style);
  return token;
}

// PB BaseProvider.FetchRawUserInfo
export async function fetchRawUserInfo(
  url: string,
  token: OAuth2Token,
  signal: AbortSignal,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<string> {
  const res = await fetch(url, {
    ...init,
    headers: { ...init.headers, authorization: authorization(token) },
    signal,
  });
  const text = await readText(res, DEFAULT_MAX_BODY_SIZE);
  if (res.status >= 400)
    throw new Error(
      `failed to fetch OAuth2 user profile via ${url} (${res.status})`,
    );
  return text;
}

export function newAuthUser(
  token: OAuth2Token,
  rawUser: Values,
  fields: Partial<AuthUser>,
): AuthUser {
  return {
    id: "",
    name: "",
    username: "",
    email: "",
    avatarURL: "",
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiry: token.expiry ? formatDate(token.expiry) : "",
    rawUser,
    ...fields,
  };
}

const github: UserFetcher = async (p, token, { signal }) => {
  const rawUser = parseObject(
    await fetchRawUserInfo(p.userInfoURL, token, signal),
  );
  const id = typed(rawUser, "id", "number");
  if (!Number.isInteger(id)) throw new Error("invalid id value");
  const user = newAuthUser(token, rawUser, {
    id: String(id),
    name: typed(rawUser, "name", "string"),
    username: typed(rawUser, "login", "string"),
    avatarURL: typed(rawUser, "avatar_url", "string"),
  });
  const res = await fetch(`${p.userInfoURL}/emails`, {
    headers: { authorization: authorization(token) },
    signal,
  });
  if ([401, 403, 404].includes(res.status)) return user;
  const emails = JSON.parse(await readText(res, DEFAULT_MAX_BODY_SIZE));
  if (!Array.isArray(emails)) throw new Error("invalid emails response");
  for (const item of emails) {
    if (!isObject(item)) throw new Error("invalid email item");
    if (
      typed(item, "verified", "boolean") &&
      typed(item, "primary", "boolean")
    ) {
      user.email = typed(item, "email", "string");
      break;
    }
  }
  return user;
};

const google: UserFetcher = async (p, token, { signal }) => {
  const rawUser = parseObject(
    await fetchRawUserInfo(p.userInfoURL, token, signal),
  );
  const user = newAuthUser(token, rawUser, {
    id: typed(rawUser, "sub", "string"),
    name: typed(rawUser, "name", "string"),
    avatarURL: typed(rawUser, "picture", "string"),
  });
  const email = typed(rawUser, "email", "string");
  if (typed(rawUser, "email_verified", "boolean")) user.email = email;
  return user;
};

// cast.ToStringSlice
function stringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return v.split(/\s+/).filter(Boolean);
  return [];
}

// PB OIDC.parseIdToken: used when the provider has no user info URL.
async function idTokenClaims(
  p: Provider,
  token: OAuth2Token,
  { app, signal }: FetchCtx,
): Promise<Values> {
  const idToken =
    typeof token.raw.id_token === "string" ? token.raw.id_token : "";
  if (idToken === "") throw new Error("empty or invalid id_token");
  const { claims } = parseUnverified(idToken);
  validateClaims(claims, {
    now: app.now(),
    leewayMs: ID_TOKEN_LEEWAY_MS,
    audience: p.clientId,
  });
  const issuers = stringList(p.extra.issuers);
  if (issuers.length > 0 && !issuers.includes(claims.iss as string))
    throw new Error("invalid iss");
  const jwksURL = typeof p.extra.jwksURL === "string" ? p.extra.jwksURL : "";
  if (jwksURL !== "")
    await validateTokenSignature(idToken, jwksURL, app.now(), signal);
  return claims;
}

const oidc: UserFetcher = async (p, token, ctx) => {
  const rawUser =
    p.userInfoURL !== ""
      ? parseObject(await fetchRawUserInfo(p.userInfoURL, token, ctx.signal))
      : await idTokenClaims(p, token, ctx);
  const user = newAuthUser(token, rawUser, {
    id: typed(rawUser, "sub", "string"),
    name: typed(rawUser, "name", "string"),
    username: typed(rawUser, "preferred_username", "string"),
    avatarURL: typed(rawUser, "picture", "string"),
  });
  const email = typed(rawUser, "email", "string");
  if (castBool(rawUser.email_verified)) user.email = email;
  return user;
};

export const userFetchers: Record<string, UserFetcher> = {
  github,
  google,
  oidc,
  oidc2: oidc,
  oidc3: oidc,
};

// Go's IsLoopback, IsUnspecified, IsPrivate, IsLinkLocalUnicast, IsLinkLocalMulticast and IsMulticast
const disallowed = new BlockList();
for (const [net, bits] of [
  ["127.0.0.0", 8],
  ["0.0.0.0", 32],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["169.254.0.0", 16],
  ["224.0.0.0", 4],
] as const)
  disallowed.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::1", 128],
  ["::", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  disallowed.addSubnet(net, bits, "ipv6");

export function isPublicIp(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const addr = mapped ? mapped[1]! : ip;
  const kind = isIP(addr);
  if (kind === 0) return false;
  return !disallowed.check(addr, kind === 4 ? "ipv4" : "ipv6");
}

// Go path.Base
function baseName(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  if (trimmed === "") return url === "" ? "." : "/";
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;

const systemResolve: Resolve = (host) => lookup(host, { all: true });

// Resolves once per connection and hands the checked address to the socket, so the name can't be
// rebound to another address between the check and the connect (PB checks at dial time).
function pinnedLookup(
  resolve: Resolve,
  allowIp: (ip: string) => boolean,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        const first = addresses[0];
        if (!first || !addresses.every((a) => allowIp(a.address)))
          return callback(
            new Error(`address of ${hostname} is invalid or disallowed`),
            "",
          );
        if (options.all) callback(null, [first]);
        else callback(null, first.address, first.family);
      },
      (err: Error) => callback(err, ""),
    );
  };
}

function get(
  url: URL,
  lookup: LookupFunction,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const send = url.protocol === "https:" ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    send(url, { lookup, signal, agent: false }, resolve).on("error", reject);
  });
}

async function readBody(
  res: IncomingMessage,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    const part = (chunk as Buffer).subarray(0, limit - size);
    chunks.push(part);
    size += part.length;
    if (size >= limit) break;
  }
  res.destroy();
  return new Uint8Array(Buffer.concat(chunks));
}

// PB safeFileFromURL: http(s) only, every hop connects only to a checked public address, 10 s
// timeout, at most 10 redirects, body capped at the default body limit.
export async function safeFileFromURL(
  url: string,
  opts: { allowIp?: (ip: string) => boolean; resolve?: Resolve } = {},
): Promise<File> {
  const allowIp = opts.allowIp ?? isPublicIp;
  const lookup = pinnedLookup(opts.resolve ?? systemResolve, allowIp);
  const signal = AbortSignal.timeout(AVATAR_TIMEOUT_MS);
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:")
      throw new Error(`unsupported URL scheme ${current.protocol}`);
    const host = current.hostname.replace(/^\[|\]$/g, "");
    // sockets skip the lookup for IP literals
    if (isIP(host) !== 0 && !allowIp(host))
      throw new Error(`address of ${host} is invalid or disallowed`);
    const res = await get(current, lookup, signal);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status <= 399 && location) {
      res.destroy();
      if (hop >= MAX_REDIRECTS) throw new Error("stopped after 10 redirects");
      current = new URL(location, current);
      continue;
    }
    if (status < 200 || status > 399) {
      res.destroy();
      throw new Error(`failed to download url ${url} (${status})`);
    }
    return new File(
      [await readBody(res, DEFAULT_MAX_BODY_SIZE)],
      baseName(url),
    );
  }
}

// PB oldCanAssignUsername
function canAssignUsername(app: App, c: Collection, username: string): boolean {
  const mapped = (c.oauth2 as { mappedFields: { username: string } })
    .mappedFields.username;
  const field = c.fields.find((f) => f.name === mapped);
  if (!field) return false;
  if (
    field.type === "text" &&
    fields.text.validate(username, field, {
      db: app.db,
      collection: c,
      record: {},
      isNew: true,
      now: app.now,
      findCollection: (name) => app.collections.find(name),
    }) !== null
  )
    return false;
  const index = findSingleColumnUniqueIndex(c.indexes, field.name);
  if (!index) return true;
  const nocase = /collate\s+nocase/i.test(index.columnsSql);
  return !app.db.get(
    `SELECT 1 FROM ${quote(c.name)} WHERE ${quote(field.name)} = ?${nocase ? " COLLATE NOCASE" : ""} LIMIT 1`,
    [username],
  );
}

function findExternalAuth(
  app: App,
  c: Collection,
  provider: string,
  providerId: string,
): Values | null {
  return (
    app.db.get<Values>(
      "SELECT * FROM _externalAuths WHERE providerId != '' AND collectionRef = ? AND provider = ? AND providerId = ? ORDER BY created DESC LIMIT 1",
      [c.id, provider, providerId],
    ) ?? null
  );
}

interface Mapped {
  id: string;
  name: string;
  username: string;
  avatarURL: string;
}

// The new record payload of PB oauth2Submit; `generated` when the password is the random one.
async function signUpPayload(
  app: App,
  c: Collection,
  user: AuthUser,
  createData: Values | undefined,
  allowIp: ((ip: string) => boolean) | undefined,
): Promise<{ payload: Values; generated: boolean }> {
  const payload: Values = { ...createData };
  if (typeof payload.email !== "string" || payload.email === "")
    payload.email = user.email;
  const mapped = (c.oauth2 as { mappedFields: Mapped }).mappedFields;
  const unset = (key: string) => key !== "" && !Object.hasOwn(payload, key);
  if (unset(mapped.id)) payload[mapped.id] = user.id;
  if (unset(mapped.name)) payload[mapped.name] = user.name;
  if (unset(mapped.username) && canAssignUsername(app, c, user.username))
    payload[mapped.username] = user.username;
  if (unset(mapped.avatarURL) && user.avatarURL !== "") {
    const field = c.fields.find((f) => f.name === mapped.avatarURL);
    if (field?.type === "file") {
      try {
        payload[mapped.avatarURL] = await safeFileFromURL(user.avatarURL, {
          allowIp,
        });
      } catch (err) {
        console.warn("heybe: failed to retrieve OAuth2 avatar:", err);
      }
    } else payload[mapped.avatarURL] = user.avatarURL;
  }
  // like PB's internal create request: a random password when none was submitted
  const generated = !Object.hasOwn(payload, "password");
  if (generated) {
    payload.password = randomSecret(30);
    payload.passwordConfirm = payload.password;
  }
  return { payload, generated };
}

// PB skips the plain password validators for the generated password: keep only its hash
function skipPlainPassword(p: PreparedWrite): void {
  const pairs = p.resolved.get("password");
  for (const [input, output] of pairs ?? [])
    if (output instanceof PasswordValue)
      pairs!.set(input, new PasswordValue(output.hash));
}

function authFailed(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ValidationError)
    return new ApiError(400, "Failed to authenticate.", err.data);
  logUnexpected(err);
  return new ApiError(400, "Failed to authenticate.");
}

type Service = ReturnType<typeof internalRecords>;

// Port of PB recordAuthWithOAuth2 and oauth2Submit: fetches the provider user, then logs in, links
// or creates the auth record in one transaction, so a failing step keeps nothing.
export async function authWithOAuth2(
  app: App,
  c: Collection,
  input: OAuth2Input,
  auth: AuthState | null,
  info: RequestInfo,
  opts: { allowIp?: (ip: string) => boolean } = {},
): Promise<{ record: Values; meta: Values }> {
  const config = providerConfigs(c).find((p) => p.name === input.provider);
  const p = config && initProvider(config);
  if (!p) throw new ApiError(500, "Missing or invalid provider config.");
  const fetchUser = (userFetchers[p.name] ?? mappers[p.name])!;

  const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  let token: OAuth2Token;
  try {
    token = await fetchToken(app, p, input, signal);
  } catch {
    throw new ApiError(400, "Failed to fetch OAuth2 token.");
  }
  let user: AuthUser;
  try {
    user = await fetchUser(p, token, { app, signal });
  } catch {
    throw new ApiError(400, "Failed to fetch OAuth2 user.");
  }

  const link = findExternalAuth(app, c, p.name, user.id);
  let record: Values | null = null;
  if (link) {
    try {
      record = internalRecords(app, c.name).findRaw(link.recordRef as string);
    } catch {
      throw new ApiError(404, "");
    }
  } else if (auth && auth.collection.id === c.id) record = auth.record;
  else if (user.email !== "")
    record = findAuthRecordByEmail(app, c, user.email);
  const isNew = record === null;

  const records = internalRecords(app, c.name);
  const links = internalRecords(app, "_externalAuths");
  const pending: [Service, PreparedWrite][] = [];
  const prepare = async (service: Service, data: Values, id?: string) => {
    const prepared = await service.prepare(data, id);
    pending.push([service, prepared]);
    return prepared;
  };
  const linkData = (recordRef: unknown) => ({
    collectionRef: c.id,
    recordRef,
    provider: p.name,
    providerId: user.id,
  });

  let committed = false;
  let saved: Values;
  try {
    if (record === null) {
      if (c.name === "_superusers")
        throw new Error("superusers are not allowed to sign-up with OAuth2");
      const { payload, generated } = await signUpPayload(
        app,
        c,
        user,
        input.createData,
        opts.allowIp,
      );
      const create = await prepare(records, payload);
      if (generated) skipPlainPassword(create);
      const id = create.ctx.recordId;
      const verify = await prepare(records, { verified: true }, id);
      const newLink = linkData(id);
      const linkWrite = await prepare(links, newLink);
      const createInfo: RequestInfo = {
        ...info,
        body: payload,
        query: {},
        method: "POST",
        context: "oauth2",
        headers: { ...info.headers, content_type: "multipart/form-data" },
      };
      saved = await app.db.write(async () => {
        try {
          await createPreparedChecked(app, c, createInfo, create);
        } catch (err) {
          // the internal create request fails with its own response
          if (err instanceof ValidationError)
            throw new ApiError(400, err.message, err.data);
          throw err;
        }
        const created = records.findRaw(id);
        // verified as long as it matches the OAuth2 data (even if the email is empty)
        if (created.email === user.email && created.verified !== true)
          await records.updatePrepared(verify, id, { verified: true });
        await links.createPrepared(linkWrite, newLink);
        return records.findRaw(id);
      });
    } else {
      const id = record.id as string;
      const isLogged =
        auth !== null && auth.collection.id === c.id && auth.record.id === id;
      // hashed ahead (bcrypt is async); used only if the record is still unverified in the transaction
      const password =
        !isLogged && record.verified !== true ? await randomPassword(c) : null;
      const update = await prepare(records, {}, id);
      const newLink = linkData(id);
      const linkWrite = await prepare(links, newLink);
      saved = await app.db.write(async () => {
        // decided on the record as it is now, not as it was before the awaits
        const current = records.findRaw(id);
        const verified = current.verified === true;
        const data: Values = {};
        // pre-hijacking with password auth: an unverified record may have been created by someone else
        if (!isLogged && !verified) {
          if (!password)
            throw new Error("the record changed during the OAuth2 login");
          data.password = password;
        }
        const email =
          current.email === "" && user.email !== ""
            ? user.email
            : (current.email as string);
        if (email !== current.email) data.email = email;
        if (!verified && (email === "" || email === user.email))
          data.verified = true;
        // pre-hijacking with another provider: an unverified record keeps only this link
        if (!verified)
          app.db.run(
            "DELETE FROM _externalAuths WHERE collectionRef = ? AND recordRef = ?",
            [c.id, id],
          );
        if (Object.keys(data).length > 0)
          await records.updatePrepared(update, id, data);
        if (!findExternalAuth(app, c, p.name, user.id))
          await links.createPrepared(linkWrite, newLink);
        return records.findRaw(id);
      });
    }
    committed = true;
  } catch (err) {
    throw authFailed(err);
  } finally {
    for (const [service, prepared] of pending)
      await service.settle(prepared, committed);
  }
  return {
    record: saved,
    // PB's AuthUser JSON field order
    meta: {
      expiry: user.expiry,
      rawUser: user.rawUser,
      id: user.id,
      name: user.name,
      username: user.username,
      avatarURL: user.avatarURL,
      accessToken: user.accessToken,
      refreshToken: user.refreshToken,
      email: user.email,
      avatarUrl: user.avatarURL,
      isNew,
    },
  };
}
