import { DEFAULT_MAX_BODY_SIZE } from "../../http/middlewares";
import { readText } from "./http";

// Port of PB tools/auth/internal/jwk and the golang-jwt claim checks used for OAuth2 id_tokens.
type Claims = Record<string, unknown>;

interface Jwk {
  kty?: string;
  kid?: string;
  alg?: string;
  e?: string;
  n?: string;
  crv?: string;
  x?: string;
}

const decodePart = (part: string): Record<string, unknown> => {
  const value = JSON.parse(Buffer.from(part, "base64url").toString());
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid token part");
  return value as Record<string, unknown>;
};

export function parseUnverified(token: string): {
  header: Record<string, unknown>;
  claims: Claims;
} {
  const parts = token.split(".");
  if (parts.length !== 3)
    throw new Error("token contains an invalid number of segments");
  return { header: decodePart(parts[0]!), claims: decodePart(parts[1]!) };
}

function numericDate(claims: Claims, key: string): number | null {
  const v = claims[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number") throw new Error(`invalid ${key} claim`);
  return v * 1000;
}

export interface ClaimRules {
  now: Date;
  leewayMs: number;
  audience: string;
  issuer?: string;
  expirationRequired?: boolean;
}

// golang-jwt Validator with WithIssuedAt, WithLeeway, WithAudience (and optionally WithIssuer/WithExpirationRequired).
export function validateClaims(claims: Claims, rules: ClaimRules): void {
  const now = rules.now.getTime();
  const exp = numericDate(claims, "exp");
  if (exp === null && rules.expirationRequired)
    throw new Error("exp claim is required");
  if (exp !== null && now >= exp + rules.leewayMs)
    throw new Error("token is expired");
  const nbf = numericDate(claims, "nbf");
  if (nbf !== null && now + rules.leewayMs < nbf)
    throw new Error("token is not valid yet");
  const iat = numericDate(claims, "iat");
  if (iat !== null && now + rules.leewayMs < iat)
    throw new Error("token used before issued");
  const aud = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (!Array.isArray(aud) || !aud.includes(rules.audience))
    throw new Error("token has invalid audience");
  if (rules.issuer !== undefined && claims.iss !== rules.issuer)
    throw new Error("token has invalid issuer");
}

const HASHES: Record<string, string> = {
  "256": "SHA-256",
  "384": "SHA-384",
  "512": "SHA-512",
};

function algorithm(
  alg: string,
  key: Jwk,
): {
  importAs: AlgorithmIdentifier | RsaHashedImportParams;
  verify: AlgorithmIdentifier | RsaPssParams;
} {
  const hash = HASHES[alg.slice(2)];
  if (key.kty === "RSA" && hash && alg.startsWith("RS"))
    return {
      importAs: { name: "RSASSA-PKCS1-v1_5", hash },
      verify: { name: "RSASSA-PKCS1-v1_5" },
    };
  if (key.kty === "RSA" && hash && alg.startsWith("PS"))
    return {
      importAs: { name: "RSA-PSS", hash },
      verify: { name: "RSA-PSS", saltLength: Number(alg.slice(2)) / 8 },
    };
  if (key.kty === "OKP" && key.crv === "Ed25519" && alg === "EdDSA")
    return { importAs: { name: "Ed25519" }, verify: { name: "Ed25519" } };
  throw new Error(`unsupported key or alg ${alg}`);
}

async function fetchKey(
  jwksURL: string,
  kid: string,
  signal: AbortSignal,
): Promise<Jwk> {
  const res = await fetch(jwksURL, { signal });
  const body = await readText(res, DEFAULT_MAX_BODY_SIZE);
  if (res.status >= 400)
    throw new Error(
      `failed to fetch JSON Web Key Set from ${jwksURL} (${res.status})`,
    );
  const keys = (JSON.parse(body) as { keys?: Jwk[] }).keys ?? [];
  const key = keys.find((k) => k.kid === kid && (k.alg ?? "") !== "");
  if (!key) throw new Error(`missing JWK with kid ${kid} and non-empty alg`);
  return key;
}

// PB jwk.ValidateTokenSignature: the key comes from the JWKS by the token's kid and its alg must match.
// `signal` is the provider request timeout; the JWKS body is capped like the other provider responses.
export async function validateTokenSignature(
  token: string,
  jwksURL: string,
  now: Date,
  signal: AbortSignal,
): Promise<void> {
  const { header, claims } = parseUnverified(token);
  const kid = typeof header.kid === "string" ? header.kid : "";
  if (kid === "") throw new Error("missing kid header value");
  const key = await fetchKey(jwksURL, kid, signal);
  if (header.alg !== key.alg) throw new Error("signing method is invalid");
  const { importAs, verify } = algorithm(key.alg!, key);
  const { kty, crv, e, n, x } = key;
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    kty === "RSA" ? { kty, e, n } : { kty, crv, x },
    importAs,
    false,
    ["verify"],
  );
  const [h, p, s] = token.split(".");
  const ok = await crypto.subtle.verify(
    verify,
    publicKey,
    Buffer.from(s!, "base64url"),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new Error("token signature is invalid");
  // jwt.Parse also checks exp and nbf, without leeway
  const exp = numericDate(claims, "exp");
  const nbf = numericDate(claims, "nbf");
  if (
    (exp !== null && now.getTime() >= exp) ||
    (nbf !== null && now.getTime() < nbf)
  )
    throw new Error("token is expired or not valid yet");
}
