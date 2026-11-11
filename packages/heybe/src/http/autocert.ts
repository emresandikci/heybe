import { X509Certificate, createPrivateKey } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Middleware } from "./router";

export interface TlsCert {
  cert: string;
  key: string;
}

export class ChallengeStore {
  private tokens = new Map<string, string>();
  set(token: string, keyAuth: string): void {
    this.tokens.set(token, keyAuth);
  }
  delete(token: string): void {
    this.tokens.delete(token);
  }
  get(token: string): string | undefined {
    return this.tokens.get(token);
  }
}

export interface CertIssuer {
  issue(hosts: string[], challenges: ChallengeStore): Promise<TlsCert>;
}

export const AUTOCERT_CACHE_DIR = ".autocert_cache";
export const LETS_ENCRYPT_DIRECTORY =
  "https://acme-v02.api.letsencrypt.org/directory";

const RENEW_BEFORE = 30 * 24 * 60 * 60 * 1000;

// Port of the PB apis.Serve certificate host list: every non-www host also gets its www host.
export function certificateHosts(
  domains: string[],
  mainHost: string,
): { hosts: string[]; wwwRedirects: string[] } {
  const hosts = domains.length ? [...domains] : [mainHost];
  const wwwRedirects: string[] = [];
  for (const host of [...hosts]) {
    if (host.startsWith("www.")) continue;
    const www = `www.${host}`;
    if (!hosts.includes(www)) {
      hosts.push(www);
      wwwRedirects.push(www);
    }
  }
  return { hosts, wwwRedirects };
}

function usable(tls: TlsCert, hosts: string[], now: Date): boolean {
  try {
    const x509 = new X509Certificate(tls.cert);
    if (!x509.checkPrivateKey(createPrivateKey(tls.key))) return false;
    const names = (x509.subjectAltName ?? "")
      .split(", ")
      .filter((n) => n.startsWith("DNS:"))
      .map((n) => n.slice(4));
    return (
      hosts.every((h) => names.includes(h)) &&
      Date.parse(x509.validTo) - now.getTime() > RENEW_BEFORE
    );
  } catch {
    return false;
  }
}

export async function ensureCertificate(o: {
  cacheDir: string;
  hosts: string[];
  issuer: CertIssuer;
  challenges: ChallengeStore;
  now: () => Date;
}): Promise<{ tls: TlsCert; renewed: boolean }> {
  const certPath = join(o.cacheDir, "cert.pem");
  const keyPath = join(o.cacheDir, "key.pem");
  const cached = await Promise.all([
    readFile(certPath, "utf8"),
    readFile(keyPath, "utf8"),
  ]).catch(() => null);
  if (cached) {
    const tls = { cert: cached[0], key: cached[1] };
    if (usable(tls, o.hosts, o.now())) return { tls, renewed: false };
  }
  const tls = await o.issuer.issue(o.hosts, o.challenges);
  await mkdir(o.cacheDir, { recursive: true, mode: 0o700 });
  await writeFile(`${keyPath}.tmp`, tls.key, { mode: 0o600 });
  await writeFile(`${certPath}.tmp`, tls.cert);
  await rename(`${keyPath}.tmp`, keyPath);
  await rename(`${certPath}.tmp`, certPath);
  return { tls, renewed: true };
}

export function acmeIssuer(
  o: { directoryUrl: string; accountKeyPath: string },
  acme?: typeof import("acme-client"),
): CertIssuer {
  return {
    async issue(hosts, challenges) {
      const lib = acme ?? (await import("acme-client"));
      let accountKey: string;
      if (existsSync(o.accountKeyPath)) {
        accountKey = await readFile(o.accountKeyPath, "utf8");
      } else {
        accountKey = String(await lib.crypto.createPrivateKey());
        await mkdir(dirname(o.accountKeyPath), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(o.accountKeyPath, accountKey, { mode: 0o600 });
      }
      const [key, csr] = await lib.crypto.createCsr({
        commonName: hosts[0],
        altNames: hosts,
      });
      const client = new lib.Client({
        directoryUrl: o.directoryUrl,
        accountKey,
      });
      const cert = await client.auto({
        csr,
        termsOfServiceAgreed: true,
        challengePriority: ["http-01"],
        challengeCreateFn: async (_authz, challenge, keyAuth) =>
          challenges.set(challenge.token, keyAuth),
        challengeRemoveFn: async (_authz, challenge) =>
          challenges.delete(challenge.token),
      });
      return { cert, key: String(key) };
    },
  };
}

const hostWithoutPort = (host: string) => host.replace(/:\d+$/, "");

// Port of Go autocert.Manager.HTTPHandler(nil).
export function acmeHttpHandler(
  challenges: ChallengeStore,
): (req: Request) => Response {
  const prefix = "/.well-known/acme-challenge/";
  return (req) => {
    const url = new URL(req.url);
    if (url.pathname.startsWith(prefix)) {
      const keyAuth = challenges.get(url.pathname.slice(prefix.length));
      return keyAuth === undefined
        ? new Response("Not Found", { status: 404 })
        : new Response(keyAuth, { headers: { "content-type": "text/plain" } });
    }
    if (req.method !== "GET" && req.method !== "HEAD")
      return new Response("Use HTTPS", { status: 400 });
    const host = hostWithoutPort(req.headers.get("host") ?? url.host);
    return new Response(null, {
      status: 302,
      headers: { location: `https://${host}${url.pathname}${url.search}` },
    });
  };
}

// Port of PB apis.wwwRedirect.
export function wwwRedirect(hosts: string[]): Middleware {
  return {
    id: "pbWWWRedirect",
    priority: -99999,
    fn: (e) => {
      const host = e.req.headers.get("host") ?? "";
      if (!host.startsWith("www.") || !hosts.includes(host)) return e.next();
      const url = new URL(e.req.url);
      const scheme = e.isTLS() ? "https://" : "http://";
      return e.redirect(
        307,
        `${scheme}${host.slice(4)}${url.pathname}${url.search}`,
      );
    },
  };
}
