const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SECRET_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomString(length: number, alphabet: string): string {
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length)
        out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

export const INSTALLER_EMAIL = "__pbinstaller@example.com";

export function newId(): string {
  return randomString(15, ID_ALPHABET);
}

export function randomSecret(length = 50): string {
  return randomString(length, SECRET_ALPHABET);
}

export function formatDate(d: Date): string {
  return d.toISOString().replace("T", " ");
}

export class ValidationError extends Error {
  readonly status = 400;

  constructor(
    message: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export class NotFoundError extends Error {
  readonly status = 404;

  constructor(message = "The requested resource wasn't found.") {
    super(message);
  }
}
