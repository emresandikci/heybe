export function tokenPayload(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1] ?? "";
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return data && typeof data === "object" ? (data as never) : {};
  } catch {
    return {};
  }
}

export function tokenExpired(
  token: string,
  nowMs: number,
  thresholdSec = 0,
): boolean {
  const payload = tokenPayload(token);
  if (Object.keys(payload).length === 0) return true;
  const exp = payload.exp;
  return !(
    exp === undefined ||
    exp === null ||
    (typeof exp === "number" && exp - thresholdSec > nowMs / 1000)
  );
}
