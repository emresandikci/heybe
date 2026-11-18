import { DEFAULT_MAX_BODY_SIZE } from "../../http/middlewares";
import { isEmail } from "../../fields/email";
import {
  type OAuth2Token,
  type UserFetcher,
  authorization,
  castBool,
  castString,
  fetchRawUserInfo,
  int,
  isObject,
  objectList,
  newAuthUser,
  parseObject,
  toObject,
  typed,
} from "./flow";
import { readJson } from "./http";
import { parseUnverified, validateClaims, validateTokenSignature } from "./jwk";

type Values = Record<string, unknown>;

const ID_TOKEN_LEEWAY_MS = 5 * 60_000;
const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";

// Go json.Unmarshal into a nested struct field: null or missing is the zero value
function obj(raw: Values, key: string): Values {
  const v = raw[key];
  if (v === undefined || v === null) return {};
  if (!isObject(v)) throw new Error(`invalid ${key} value`);
  return v;
}

const items = (raw: Values, key: string) => objectList(raw[key]);

const authed = (url: string, token: OAuth2Token, signal: AbortSignal) =>
  fetch(url, { headers: { authorization: authorization(token) }, signal });

const jsonBody = (query: string) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query }),
});

const userInfo = async (
  p: { userInfoURL: string },
  token: OAuth2Token,
  signal: AbortSignal,
  init?: Parameters<typeof fetchRawUserInfo>[3],
) => parseObject(await fetchRawUserInfo(p.userInfoURL, token, signal, init));

// PB Apple: the user is the verified id_token, there is no user info endpoint.
export const makeApple =
  (jwksURL: string): UserFetcher =>
  async (p, token, { app, signal }) => {
    const idToken =
      typeof token.raw.id_token === "string" ? token.raw.id_token : "";
    if (idToken === "") throw new Error("empty id_token");
    const { claims } = parseUnverified(idToken);
    validateClaims(claims, {
      now: app.now(),
      leewayMs: ID_TOKEN_LEEWAY_MS,
      audience: p.clientId,
      issuer: APPLE_ISSUER,
      expirationRequired: true,
    });
    await validateTokenSignature(idToken, jwksURL, app.now(), signal);
    const user = newAuthUser(token, claims, {
      id: typed(claims, "sub", "string"),
      name: typed(claims, "name", "string"),
    });
    const email = typed(claims, "email", "string");
    if (castBool(claims.email_verified)) user.email = email;
    return user;
  };

const bitbucket: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal);
  const status = typed(raw, "account_status", "string");
  const user = newAuthUser(token, raw, {
    id: typed(raw, "uuid", "string"),
    name: typed(raw, "display_name", "string"),
    username: typed(raw, "username", "string"),
    avatarURL: typed(obj(obj(raw, "links"), "avatar"), "href", "string"),
  });
  if (status !== "active") throw new Error("the Bitbucket user is not active");
  const res = await authed(`${p.userInfoURL}/emails`, token, signal);
  if (res.status >= 400) return user;
  const emails = toObject(await readJson(res, DEFAULT_MAX_BODY_SIZE));
  for (const v of items(emails, "values"))
    if (
      typed(v, "is_primary", "boolean") &&
      typed(v, "is_confirmed", "boolean")
    ) {
      user.email = typed(v, "email", "string");
      break;
    }
  return user;
};

const box: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal);
  const status = typed(raw, "status", "string");
  const user = newAuthUser(token, raw, {
    id: typed(raw, "id", "string"),
    name: typed(raw, "name", "string"),
    avatarURL: typed(raw, "avatar_url", "string"),
    // Box requires a verified email for OAuth authorization
    email: typed(raw, "login", "string"),
  });
  if (status !== "active")
    throw new Error(`Box user account is not active (status: "${status}")`);
  return user;
};

const discord: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal);
  const id = typed(raw, "id", "string");
  const username = typed(raw, "username", "string");
  const discriminator = typed(raw, "discriminator", "string");
  const avatar = typed(raw, "avatar", "string");
  const email = typed(raw, "email", "string");
  const verified = typed(raw, "verified", "boolean");
  let name = typed(raw, "global_name", "string");
  if (name === "") {
    name = username;
    if (discriminator !== "" && discriminator !== "0")
      name += `#${discriminator}`;
  }
  return newAuthUser(token, raw, {
    id,
    name,
    username,
    avatarURL:
      avatar !== ""
        ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.png`
        : "",
    email: verified ? email : "",
  });
};

const facebook: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal);
  return newAuthUser(token, raw, {
    id: typed(raw, "id", "string"),
    name: typed(raw, "name", "string"),
    email: typed(raw, "email", "string"),
    avatarURL: typed(obj(obj(raw, "picture"), "data"), "url", "string"),
  });
};

const gitea: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal);
  const user = newAuthUser(token, raw, {
    id: String(int(raw, "id")),
    name: typed(raw, "full_name", "string"),
    username: typed(raw, "login", "string"),
    avatarURL: typed(raw, "avatar_url", "string"),
  });
  if (!typed(raw, "active", "boolean"))
    throw new Error("user account is not active");
  const res = await authed(`${p.userInfoURL}/emails`, token, signal);
  if ([401, 403, 404].includes(res.status)) return user;
  const emails = objectList(await readJson(res, DEFAULT_MAX_BODY_SIZE));
  for (const item of emails) {
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

async function giteeEmail(
  token: OAuth2Token,
  signal: AbortSignal,
): Promise<string> {
  const res = await authed("https://gitee.com/api/v5/emails", token, signal);
  if ([401, 403, 404].includes(res.status)) return "";
  try {
    const list = await readJson(res, DEFAULT_MAX_BODY_SIZE);
    if (!Array.isArray(list)) return "";
    const emails = objectList(list).map((item) => {
      const scope = item.scope ?? [];
      if (!Array.isArray(scope) || scope.some((s) => typeof s !== "string"))
        throw new Error("invalid scope");
      return {
        email: typed(item, "email", "string"),
        state: typed(item, "state", "string"),
        scope: scope as string[],
      };
    });
    return (
      emails.find(
        (e) =>
          e.state === "confirmed" &&
          e.scope.includes("primary") &&
          isEmail(e.email),
      )?.email ?? ""
    );
  } catch {
    return "";
  }
}

const gitee: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal);
  const email = typed(raw, "email", "string");
  return newAuthUser(token, raw, {
    id: String(int(raw, "id")),
    name: typed(raw, "name", "string"),
    username: typed(raw, "login", "string"),
    avatarURL: typed(raw, "avatar_url", "string"),
    email:
      email !== "" && isEmail(email) ? email : await giteeEmail(token, signal),
  });
};

const gitlab: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal);
  const user = newAuthUser(token, raw, {
    id: String(int(raw, "id")),
    name: typed(raw, "name", "string"),
    username: typed(raw, "username", "string"),
    avatarURL: typed(raw, "avatar_url", "string"),
  });
  const email = typed(raw, "email", "string");
  const confirmedAt = typed(raw, "confirmed_at", "string");
  if (isNonZeroRFC3339(confirmedAt)) user.email = email;
  return user;
};

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const GO_ZERO_TIME_MS = -62135596800000;

// Go: time.Parse(time.RFC3339, v) succeeds and the time is not the zero instant
function isNonZeroRFC3339(value: string): boolean {
  const m = RFC3339.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m
    .slice(1, 7)
    .map(Number) as [number, number, number, number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return false;
  let offset = 0;
  if (m[7]) {
    const offsetHour = Number(m[8]);
    const offsetMinute = Number(m[9]);
    if (offsetHour > 23 || offsetMinute > 59) return false;
    offset =
      (offsetHour * 60 + offsetMinute) * 60_000 * (m[7] === "-" ? -1 : 1);
  }
  return date.getTime() - offset !== GO_ZERO_TIME_MS;
}

const instagram: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal);
  if (!("permissions" in raw)) {
    const permissions = token.raw.permissions;
    if (permissions !== undefined && permissions !== null)
      raw.permissions = permissions;
  }
  return newAuthUser(token, raw, {
    id: typed(raw, "user_id", "string"),
    name: typed(raw, "name", "string"),
    username: typed(raw, "username", "string"),
    avatarURL: typed(raw, "profile_picture_url", "string"),
  });
};

const kakao: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal);
  const profile = obj(raw, "properties");
  const account = obj(raw, "kakao_account");
  const user = newAuthUser(token, raw, {
    id: String(int(raw, "id")),
    username: typed(profile, "nickname", "string"),
    avatarURL: typed(profile, "profile_image", "string"),
  });
  const email = typed(account, "email", "string");
  if (
    typed(account, "is_email_valid", "boolean") &&
    typed(account, "is_email_verified", "boolean")
  )
    user.email = email;
  return user;
};

const lark: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal);
  const data = obj(raw, "data");
  return newAuthUser(token, raw, {
    id: typed(data, "union_id", "string"),
    name: typed(data, "name", "string"),
    avatarURL: typed(data, "avatar_url", "string"),
  });
};

const linear: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(
    p,
    token,
    signal,
    jsonBody(
      "query Me { viewer { id displayName name email avatarUrl active } }",
    ),
  );
  const viewer = obj(obj(raw, "data"), "viewer");
  const user = newAuthUser(token, raw, {
    id: typed(viewer, "id", "string"),
    name: typed(viewer, "name", "string"),
    username: typed(viewer, "displayName", "string"),
    email: typed(viewer, "email", "string"),
    avatarURL: typed(viewer, "avatarUrl", "string"),
  });
  if (!typed(viewer, "active", "boolean"))
    throw new Error("the Linear user account is not active");
  return user;
};

const livechat: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal);
  const user = newAuthUser(token, raw, {
    id: typed(raw, "account_id", "string"),
    name: typed(raw, "name", "string"),
    avatarURL: typed(raw, "avatar_url", "string"),
  });
  const email = typed(raw, "email", "string");
  if (typed(raw, "email_verified", "boolean")) user.email = email;
  return user;
};

const mailcow: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal);
  const user = newAuthUser(token, raw, {
    id: typed(raw, "id", "string"),
    name: typed(raw, "full_name", "string"),
    username: typed(raw, "username", "string"),
    email: typed(raw, "email", "string"),
  });
  if (int(raw, "active") !== 1n)
    throw new Error("the mailcow user is not active");
  // mailcow usernames are usually just the email addresses
  if (user.username.includes("@")) user.username = user.username.split("@")[0]!;
  return user;
};

function idTokenClaims(token: OAuth2Token, now: Date): Values | null {
  const idToken =
    typeof token.raw.id_token === "string" ? token.raw.id_token : "";
  if (idToken === "") return null;
  try {
    const { claims } = parseUnverified(idToken);
    // loosely validated: the token comes straight from the provider's token endpoint
    validateClaims(claims, { now, leewayMs: ID_TOKEN_LEEWAY_MS });
    return claims;
  } catch {
    return null;
  }
}

const claimString = (claims: Values | null, key: string) => {
  const v = claims?.[key];
  return typeof v === "string" ? v : "";
};

const microsoft: UserFetcher = async (p, token, { app, signal }) => {
  const raw = await userInfo(p, token, signal);
  const user = newAuthUser(token, raw, {
    id: typed(raw, "id", "string"),
    name: typed(raw, "displayName", "string"),
  });
  const mail = typed(raw, "mail", "string");
  const claims = () => idTokenClaims(token, app.now());
  const primary = () => claimString(claims(), "verified_primary_email");
  const xmsEdov = () =>
    castBool(claims()?.xms_edov) ? claimString(claims(), "email") : "";
  switch (p.extra.idTokenEmailClaim) {
    case "any_verified":
      user.email = primary() || xmsEdov();
      break;
    case "verified_primary_email":
      user.email = primary();
      break;
    case "email_and_xms_edov":
      user.email = xmsEdov();
      break;
    case "email":
      user.email = claimString(claims(), "email");
      break;
    default:
      user.email = mail;
  }
  return user;
};

const monday: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(
    p,
    token,
    signal,
    jsonBody("query { me { id enabled name email is_verified photo_small }}"),
  );
  const me = obj(obj(raw, "data"), "me");
  const user = newAuthUser(token, raw, {
    id: typed(me, "id", "string"),
    name: typed(me, "name", "string"),
    avatarURL: typed(me, "photo_small", "string"),
  });
  const email = typed(me, "email", "string");
  const verified = typed(me, "is_verified", "boolean");
  if (!typed(me, "enabled", "boolean"))
    throw new Error("the monday.com user account is not enabled");
  if (verified) user.email = email;
  return user;
};

const notion: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal, {
    headers: { "notion-version": "2022-06-28" },
  });
  const owner = obj(obj(raw, "bot"), "owner");
  const person = obj(owner, "user");
  return newAuthUser(token, raw, {
    id: typed(person, "id", "string"),
    name: typed(person, "name", "string"),
    email: typed(obj(person, "person"), "email", "string"),
    avatarURL: typed(person, "avatar_url", "string"),
  });
};

const patreon: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal);
  const data = obj(raw, "data");
  const attributes = obj(data, "attributes");
  const user = newAuthUser(token, raw, {
    id: typed(data, "id", "string"),
    username: typed(attributes, "vanity", "string"),
    name: typed(attributes, "full_name", "string"),
    avatarURL: typed(attributes, "image_url", "string"),
  });
  const email = typed(attributes, "email", "string");
  if (typed(attributes, "is_email_verified", "boolean")) user.email = email;
  return user;
};

const planningcenter: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal);
  const data = obj(raw, "data");
  const attributes = obj(data, "attributes");
  const user = newAuthUser(token, raw, {
    id: typed(data, "id", "string"),
    name: typed(attributes, "name", "string"),
    avatarURL: typed(attributes, "avatar", "string"),
  });
  if (typed(attributes, "status", "string") !== "active")
    throw new Error("the user is not active");
  // the email is not mapped: users can have several and it is not clear which are verified
  return user;
};

const spotify: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal);
  const images = items(raw, "images");
  return newAuthUser(token, raw, {
    id: typed(raw, "id", "string"),
    name: typed(raw, "display_name", "string"),
    avatarURL: images[0] ? typed(images[0], "url", "string") : "",
  });
};

const strava: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal);
  const id = int(raw, "id");
  return newAuthUser(token, raw, {
    id: id !== 0n ? String(id) : "",
    name: `${typed(raw, "firstname", "string")} ${typed(raw, "lastname", "string")}`,
    username: typed(raw, "username", "string"),
    avatarURL: typed(raw, "profile", "string"),
  });
};

const trakt: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal, {
    headers: {
      "content-type": "application/json",
      "trakt-api-key": p.clientId,
      "trakt-api-version": "2",
    },
  });
  const user = obj(raw, "user");
  return newAuthUser(token, raw, {
    id: typed(obj(user, "ids"), "uuid", "string"),
    username: typed(user, "username", "string"),
    name: typed(user, "name", "string"),
    avatarURL: typed(obj(obj(user, "images"), "avatar"), "full", "string"),
  });
};

const twitch: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal, {
    headers: { "client-id": p.clientId },
  });
  const first = items(raw, "data")[0];
  if (!first) throw new Error("failed to fetch AuthUser data");
  return newAuthUser(token, raw, {
    id: typed(first, "id", "string"),
    name: typed(first, "display_name", "string"),
    username: typed(first, "login", "string"),
    email: typed(first, "email", "string"),
    avatarURL: typed(first, "profile_image_url", "string"),
  });
};

const twitter: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal);
  const data = obj(raw, "data");
  return newAuthUser(token, raw, {
    id: typed(data, "id", "string"),
    name: typed(data, "name", "string"),
    username: typed(data, "username", "string"),
    email: typed(data, "confirmed_email", "string"),
    avatarURL: typed(data, "profile_image_url", "string"),
  });
};

const vk: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal);
  const first = items(raw, "response")[0];
  if (!first) throw new Error("missing response entry");
  const user = newAuthUser(token, raw, {
    id: String(int(first, "id")),
    name: `${typed(first, "first_name", "string")} ${typed(first, "last_name", "string")}`.trim(),
    username: typed(first, "screen_name", "string"),
    avatarURL: typed(first, "photo_max", "string"),
  });
  const email = token.raw.email;
  if (email !== undefined && email !== null) user.email = String(email);
  return user;
};

const wakatime: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal);
  const data = obj(raw, "data");
  const user = newAuthUser(token, raw, {
    id: typed(data, "id", "string"),
    name: typed(data, "display_name", "string"),
    username: typed(data, "username", "string"),
  });
  const email = typed(data, "email", "string");
  const photo = typed(data, "photo", "string");
  // is_email_public is not checked: the auth collection has its own emailVisibility
  if (typed(data, "is_email_confirmed", "boolean")) user.email = email;
  if (typed(data, "photo_public", "boolean")) user.avatarURL = photo;
  return user;
};

const yandex: UserFetcher = async (p, token, { signal }) => {
  const raw = await userInfo(p, token, signal);
  const user = newAuthUser(token, raw, {
    id: typed(raw, "id", "string"),
    name: typed(raw, "real_name", "string"),
    username: typed(raw, "login", "string"),
    email: typed(raw, "default_email", "string"),
  });
  const avatarId = typed(raw, "default_avatar_id", "string");
  if (!typed(raw, "is_avatar_empty", "boolean"))
    user.avatarURL = `https://avatars.yandex.net/get-yapic/${avatarId}/islands-200`;
  return user;
};

export const mappers: Record<string, UserFetcher> = {
  apple: makeApple(APPLE_JWKS_URL),
  bitbucket,
  box,
  discord,
  facebook,
  gitea,
  gitee,
  gitlab,
  instagram2: instagram,
  kakao,
  lark,
  linear,
  livechat,
  mailcow,
  microsoft,
  monday,
  notion,
  patreon,
  planningcenter,
  spotify,
  strava,
  trakt,
  twitch,
  twitter,
  vk,
  wakatime,
  yandex,
};
