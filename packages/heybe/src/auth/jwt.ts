import { createHmac, timingSafeEqual } from "node:crypto";

type Claims = Record<string, unknown>;

const HEADER = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

function b64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}

function sign(input: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(input).digest();
}

export function signJwt(claims: Claims, secret: string): string {
  const sorted = Object.fromEntries(
    Object.entries(claims).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  const input = `${HEADER}.${b64url(JSON.stringify(sorted))}`;
  return `${input}.${b64url(sign(input, secret))}`;
}

function timeValid(claims: Claims, now: Date): boolean {
  const at = now.getTime() / 1000;
  const check = (key: string, ok: (v: number) => boolean) => {
    const v = claims[key];
    if (v === undefined || v === null) return true;
    return typeof v === "number" && ok(v);
  };
  return (
    check("exp", (v) => at < v) &&
    check("nbf", (v) => at >= v) &&
    check("iat", (v) => at >= v)
  );
}

function parts(token: string): { head: Claims; claims: Claims } | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const head = JSON.parse(Buffer.from(segments[0]!, "base64url").toString());
    const claims = JSON.parse(
      Buffer.from(segments[1]!, "base64url").toString(),
    );
    const isObject = (v: unknown) =>
      v !== null && typeof v === "object" && !Array.isArray(v);
    return isObject(head) && isObject(claims) ? { head, claims } : null;
  } catch {
    return null;
  }
}

export function parseUnverifiedJwt(
  token: string,
  now: () => Date,
): Claims | null {
  const parsed = parts(token);
  return parsed && timeValid(parsed.claims, now()) ? parsed.claims : null;
}

export function verifyJwt(
  token: string,
  secret: string,
  now: () => Date,
): Claims | null {
  const parsed = parts(token);
  if (!parsed || parsed.head.alg !== "HS256") return null;
  const [h, p, s] = token.split(".") as [string, string, string];
  const given = Buffer.from(s, "base64url");
  const expected = sign(`${h}.${p}`, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return null;
  return timeValid(parsed.claims, now()) ? parsed.claims : null;
}
