import { expect, test } from "bun:test";
import { providers } from "../../../../packages/heybe/src/auth/oauth2/providers";
import { OAUTH2_PROVIDERS, randomSecret } from "./oauth2-providers";

test("provider list matches the server's providers", () => {
  expect(OAUTH2_PROVIDERS.map((p) => p.name).sort()).toEqual(
    Object.keys(providers).sort(),
  );
  for (const p of OAUTH2_PROVIDERS) {
    expect(p.needsURLs).toBe(providers[p.name]!.authURL === "");
    if (!p.name.startsWith("oidc"))
      expect(p.displayName).toBe(providers[p.name]!.displayName);
  }
});

test("randomSecret makes 50 alphanumeric characters by default", () => {
  expect(randomSecret()).toMatch(/^[a-zA-Z0-9]{50}$/);
  expect(randomSecret(12)).toHaveLength(12);
  expect(randomSecret()).not.toBe(randomSecret());
});
