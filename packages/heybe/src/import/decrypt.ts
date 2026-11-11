import { createDecipheriv } from "node:crypto";

const NONCE_SIZE = 12;
const TAG_SIZE = 16;

// PB security.Decrypt: base64(nonce || ciphertext || tag), AES-256-GCM with a 32 character key
export function decryptPbValue(cipherText: string, key: string): string {
  const bytes = Buffer.from(cipherText, "base64");
  if (bytes.length < NONCE_SIZE + TAG_SIZE)
    throw new Error("cipher text too short");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "utf8"),
    bytes.subarray(0, NONCE_SIZE),
  );
  decipher.setAuthTag(bytes.subarray(bytes.length - TAG_SIZE));
  return Buffer.concat([
    decipher.update(bytes.subarray(NONCE_SIZE, bytes.length - TAG_SIZE)),
    decipher.final(),
  ]).toString("utf8");
}
