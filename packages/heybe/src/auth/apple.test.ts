import { expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { appleFormErrors, generateAppleClientSecret } from "./apple";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const form = {
  clientId: "com.example.app",
  teamId: "TEAM123456",
  keyId: "KEY1234567",
  privateKey,
  duration: 3600,
};

test("generated secret verifies with the public key and carries PB's claims", async () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const secret = await generateAppleClientSecret(form, now);
  const [header, claims, signature] = secret.split(".");
  expect(
    verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature!, "base64url"),
    ),
  ).toBe(true);
  const decode = (s: string) =>
    JSON.parse(Buffer.from(s, "base64url").toString());
  expect(decode(header!)).toEqual({
    alg: "ES256",
    kid: "KEY1234567",
    typ: "JWT",
  });
  expect(decode(claims!)).toEqual({
    iss: "TEAM123456",
    sub: "com.example.app",
    aud: ["https://appleid.apple.com"],
    exp: 1767225600 + 3600,
    iat: 1767225600,
  });
});

test("rejects a key that is not a P-256 PKCS8 key", async () => {
  const bad = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----";
  await expect(
    generateAppleClientSecret({ ...form, privateKey: bad }, new Date(0)),
  ).rejects.toThrow();
});

test("validates the form like PB", () => {
  expect(appleFormErrors(form)).toEqual({});
  expect(Object.keys(appleFormErrors({ ...form, duration: 15777001 }))).toEqual(
    ["duration"],
  );
  expect(
    Object.keys(appleFormErrors({ ...form, duration: 0, teamId: "" })),
  ).toEqual(["teamId", "duration"]);
});
