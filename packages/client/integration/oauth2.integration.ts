import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  type OAuth2Mock,
  startOAuth2Mock,
} from "../../heybe/contract/oauth2-mock";
import type { HeybeClient } from "../src/client";
import { HeybeError } from "../src/error";
import type { OAuth2Config } from "../src/oauth2";
import { same, startPair, type Name, type Pair } from "./pair";

let pair: Pair;
let mock: OAuth2Mock;

const NAMES: Name[] = ["pocketbase", "heybe"];

beforeAll(async () => {
  mock = startOAuth2Mock();
  pair = await startPair();
  for (const name of NAMES)
    await pair.admin[name].send("/api/collections", {
      method: "POST",
      body: {
        name: "oausers",
        type: "auth",
        createRule: "",
        fields: [{ name: "name", type: "text" }],
        oauth2: {
          enabled: true,
          mappedFields: { name: "name" },
          providers: [
            {
              name: "google",
              clientId: mock.clientId,
              clientSecret: mock.clientSecret,
              authURL: `${mock.url}/authorize`,
              tokenURL: `${mock.url}/token`,
              userInfoURL: `${mock.url}/userinfo`,
            },
          ],
        },
      },
    });
}, 60_000);

afterAll(async () => {
  await pair?.stop();
  await mock?.stop();
});

// the mock provider redirects to the server's /api/oauth2-redirect, which fires @oauth2
const approve = (code: string) => async (url: string) => {
  const res = await fetch(`${url}&code=${code}`, { redirect: "manual" });
  await fetch(res.headers.get("location")!, { redirect: "manual" });
};

const deny = async (url: string) => {
  const params = new URL(url).searchParams;
  const back = new URL(params.get("redirect_uri")!);
  back.searchParams.set("state", params.get("state")!);
  back.searchParams.set("error", "access_denied");
  await fetch(back, { redirect: "manual" });
};

const flow = (c: HeybeClient, config: Omit<OAuth2Config<unknown>, "signal">) =>
  c.auth("oausers").withOAuth2({
    ...config,
    signal: AbortSignal.timeout(2000),
  });

async function login(code: string, isNew: boolean) {
  await same(pair, async (c) => {
    try {
      const { token, record, meta } = await flow(c, {
        provider: "google",
        urlCallback: approve(code),
      });
      expect(meta?.isNew).toBe(isNew);
      return {
        token,
        record,
        meta: Object.fromEntries(
          Object.entries(meta ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)),
        ),
        saved: c.authStore.token === token,
      };
    } catch (err) {
      // not a HeybeError, so `same` does not turn a failed login into a comparable value
      throw new Error((err as Error).message);
    }
  });
}

const rejection = (
  config: Omit<OAuth2Config<unknown>, "signal">,
  message: string,
) =>
  same(pair, async (c) => {
    const err = await flow(c, config).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HeybeError);
    expect((err as HeybeError).message).toBe(message);
    return err;
  });

test("a new user is created and logged in", async () => {
  mock.set("new-1", {
    user: {
      sub: "g-1",
      name: "Gina",
      email: "gina@example.com",
      email_verified: true,
    },
  });
  await login("new-1", true);
});

test("an existing linked user is logged in", async () => {
  mock.set("existing-1", {
    user: {
      sub: "g-1",
      name: "Gina",
      email: "gina@example.com",
      email_verified: true,
    },
  });
  await login("existing-1", false);
});

test("a provider error rejects", () =>
  rejection(
    { provider: "google", urlCallback: deny },
    "OAuth2 redirect error or missing code: access_denied",
  ));

test("an unknown provider rejects", () =>
  rejection(
    { provider: "nope", urlCallback: () => {} },
    'Missing or invalid provider "nope".',
  ));
