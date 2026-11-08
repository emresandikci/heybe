import { runeLength } from "../fields/shared";

// Port of PB forms/apple_client_secret_create.go.
export interface AppleSecretForm {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
  duration: number;
}

type FieldError = {
  code: string;
  message: string;
  params?: Record<string, unknown>;
};

const MAX_DURATION = 15777000;
const PRIVATE_KEY =
  /-----BEGIN PRIVATE KEY----[\s\S]+-----END PRIVATE KEY-----/;

const required: FieldError = {
  code: "validation_required",
  message: "Cannot be blank.",
};

function exactLength(v: string, n: number): FieldError | null {
  if (v === "") return required;
  if (runeLength(v) === n) return null;
  return {
    code: "validation_length_invalid",
    message: `The length must be exactly ${n}.`,
    params: { min: n, max: n },
  };
}

export function appleFormErrors(
  form: AppleSecretForm,
): Record<string, FieldError> {
  const errors: Record<string, FieldError | null> = {
    clientId: form.clientId === "" ? required : null,
    teamId: exactLength(form.teamId, 10),
    keyId: exactLength(form.keyId, 10),
    privateKey:
      form.privateKey === ""
        ? required
        : PRIVATE_KEY.test(form.privateKey)
          ? null
          : {
              code: "validation_match_invalid",
              message: "Must be in a valid format.",
            },
    duration:
      form.duration === 0
        ? required
        : form.duration < 1
          ? {
              code: "validation_min_greater_equal_than_required",
              message: "Must be no less than 1.",
              params: { threshold: 1 },
            }
          : form.duration > MAX_DURATION
            ? {
                code: "validation_max_less_equal_than_required",
                message: `Must be no greater than ${MAX_DURATION}.`,
                params: { threshold: MAX_DURATION },
              }
            : null,
  };
  return Object.fromEntries(
    Object.entries(errors).filter(([, v]) => v !== null),
  ) as Record<string, FieldError>;
}

const b64url = (data: string | ArrayBuffer) =>
  Buffer.from(data as string).toString("base64url");

// ES256 JWT as built by PB with golang-jwt: Web Crypto returns the raw r||s signature JWT requires.
export async function generateAppleClientSecret(
  form: AppleSecretForm,
  now: Date,
): Promise<string> {
  const pem = form.privateKey.trim();
  const body = pem
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Buffer.from(body, "base64"),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const iat = Math.floor(now.getTime() / 1000);
  const input = [
    b64url(JSON.stringify({ alg: "ES256", kid: form.keyId, typ: "JWT" })),
    b64url(
      JSON.stringify({
        iss: form.teamId,
        sub: form.clientId,
        aud: ["https://appleid.apple.com"],
        exp: iat + form.duration,
        iat,
      }),
    ),
  ].join(".");
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Buffer.from(input),
  );
  return `${input}.${b64url(signature)}`;
}
