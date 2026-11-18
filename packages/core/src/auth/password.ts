const BCRYPT_MAX_BYTES = 72;

// Go's bcrypt compares the first 72 bytes only, Bun pre-hashes longer input
export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  const bytes = new TextEncoder().encode(plain);
  return Bun.password.verify(
    hash.startsWith("$2a$") ? bytes.subarray(0, BCRYPT_MAX_BYTES) : bytes,
    hash,
  );
}
