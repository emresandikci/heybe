// Local OAuth2 provider for the contract tests: both targets point their provider URLs here.
export interface MockProfile {
  // the user-info JSON (google/oidc style `sub`, github style `id` and `login`)
  user: Record<string, unknown>;
  // github `/user/emails`; 404 when missing
  emails?: { email: string; verified: boolean; primary: boolean }[];
  tokenError?: boolean;
  userError?: boolean;
  // returned with the token (OIDC without a user info URL)
  idToken?: string;
}

export interface OAuth2Mock {
  url: string;
  avatarURL: string;
  clientId: string;
  clientSecret: string;
  set(code: string, profile: MockProfile): void;
  // the JSON Web Key Set served at /jwks
  setJwks(keys: object[]): void;
  stop(): Promise<void>;
}

// 1x1 transparent PNG
const AVATAR = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const CLIENT_ID = "client-id";
const CLIENT_SECRET = "client-secret";

const s256 = (verifier: string) =>
  new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");

function clientOk(req: Request, form: URLSearchParams): boolean {
  const basic = /^Basic (.+)$/.exec(req.headers.get("authorization") ?? "");
  if (basic) {
    const [id, secret] = Buffer.from(basic[1]!, "base64")
      .toString()
      .split(":")
      .map(decodeURIComponent);
    return id === CLIENT_ID && secret === CLIENT_SECRET;
  }
  return (
    form.get("client_id") === CLIENT_ID &&
    form.get("client_secret") === CLIENT_SECRET
  );
}

export function startOAuth2Mock(): OAuth2Mock {
  const profiles = new Map<string, MockProfile>();
  // PKCE challenges sent to /authorize per code (one per target)
  const challenges = new Map<string, Set<string>>();
  let jwks: object[] = [];

  const fromToken = (req: Request) => {
    const token = /^Bearer at-(.+)$/.exec(
      req.headers.get("authorization") ?? "",
    );
    return token ? profiles.get(token[1]!) : undefined;
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === "/authorize") {
        const code = url.searchParams.get("code") ?? "";
        const challenge = url.searchParams.get("code_challenge");
        if (challenge) {
          if (!challenges.has(code)) challenges.set(code, new Set());
          challenges.get(code)!.add(challenge);
        }
        const back = new URL(url.searchParams.get("redirect_uri") ?? "");
        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state") ?? "");
        return Response.redirect(back.toString(), 302);
      }
      if (path === "/token" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        if (!clientOk(req, form))
          return Response.json({ error: "invalid_client" }, { status: 401 });
        const code = form.get("code") ?? "";
        const profile = profiles.get(code);
        const expected = challenges.get(code);
        const verifier = form.get("code_verifier") ?? "";
        if (
          form.get("grant_type") !== "authorization_code" ||
          !profile ||
          profile.tokenError ||
          (expected && !expected.has(s256(verifier)))
        )
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({
          access_token: `at-${code}`,
          token_type: "Bearer",
          refresh_token: `rt-${code}`,
          expires_in: 3600,
          ...(profile.idToken ? { id_token: profile.idToken } : {}),
        });
      }
      if (path === "/jwks") return Response.json({ keys: jwks });
      if (path === "/avatar.png")
        return new Response(AVATAR, {
          headers: { "content-type": "image/png" },
        });
      const profile = fromToken(req);
      if (!profile) return Response.json({}, { status: 401 });
      if (path === "/userinfo" || path === "/github/user")
        return profile.userError
          ? Response.json({ error: "boom" }, { status: 500 })
          : Response.json(profile.user);
      if (path === "/github/user/emails")
        return profile.emails
          ? Response.json(profile.emails)
          : Response.json({}, { status: 404 });
      return Response.json({}, { status: 404 });
    },
  });

  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    avatarURL: `${url}/avatar.png`,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    set: (code, profile) => profiles.set(code, profile),
    setJwks: (keys) => {
      jwks = keys;
    },
    stop: () => server.stop(true),
  };
}
