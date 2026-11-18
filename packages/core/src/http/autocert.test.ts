import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import { testApp } from "../test-app";
import {
  ChallengeStore,
  type TlsCert,
  acmeHttpHandler,
  acmeIssuer,
  certificateHosts,
  ensureCertificate,
} from "./autocert";
import { serve } from "./server";

const fixture = (host: string): TlsCert => ({
  cert: readFileSync(join(import.meta.dir, "testdata", `${host}.crt`), "utf8"),
  key: readFileSync(join(import.meta.dir, "testdata", `${host}.key`), "utf8"),
});
const example = fixture("example.test");
const other = fixture("other.test");
const x509 = new X509Certificate(example.cert);
const DAY = 24 * 60 * 60 * 1000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "heybe-autocert-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("certificateHosts", () => {
  test("certificateHosts adds www hosts like PB", () => {
    expect(certificateHosts(["example.test"], "0.0.0.0")).toEqual({
      hosts: ["example.test", "www.example.test"],
      wwwRedirects: ["www.example.test"],
    });
    expect(certificateHosts(["www.a.test"], "0.0.0.0")).toEqual({
      hosts: ["www.a.test"],
      wwwRedirects: [],
    });
    expect(certificateHosts(["a.test", "www.a.test"], "0.0.0.0")).toEqual({
      hosts: ["a.test", "www.a.test"],
      wwwRedirects: [],
    });
    expect(certificateHosts([], "127.0.0.1")).toEqual({
      hosts: ["127.0.0.1", "www.127.0.0.1"],
      wwwRedirects: ["www.127.0.0.1"],
    });
  });
});

describe("ensureCertificate", () => {
  const setup = (issued: TlsCert, nowMs = Date.parse(x509.validFrom) + DAY) => {
    const calls: string[][] = [];
    const run = () =>
      ensureCertificate({
        cacheDir: dir,
        hosts: ["example.test", "www.example.test"],
        issuer: {
          issue: async (hosts) => {
            calls.push(hosts);
            return issued;
          },
        },
        challenges: new ChallengeStore(),
        now: () => new Date(nowMs),
      });
    return { calls, run };
  };
  const cache = (tls: TlsCert) => {
    writeFileSync(join(dir, "cert.pem"), tls.cert);
    writeFileSync(join(dir, "key.pem"), tls.key);
  };
  const onDisk = () => readFileSync(join(dir, "cert.pem"), "utf8");

  test("a valid cached certificate is reused", async () => {
    cache(example);
    const s = setup(other);
    expect(await s.run()).toEqual({ tls: example, renewed: false });
    expect(s.calls).toHaveLength(0);
  });

  test("a missing cache is issued and written", async () => {
    const s = setup(example);
    expect(await s.run()).toEqual({ tls: example, renewed: true });
    expect(s.calls).toEqual([["example.test", "www.example.test"]]);
    expect(onDisk()).toBe(example.cert);
    expect(readFileSync(join(dir, "key.pem"), "utf8")).toBe(example.key);
  });

  test("a cache for other hosts is reissued", async () => {
    cache(other);
    const s = setup(example);
    expect((await s.run()).renewed).toBe(true);
    expect(s.calls).toHaveLength(1);
    expect(onDisk()).toBe(example.cert);
  });

  test("a certificate expiring within 30 days is reissued", async () => {
    cache(example);
    const s = setup(example, Date.parse(x509.validTo) - 29 * DAY);
    expect((await s.run()).renewed).toBe(true);
    expect(s.calls).toHaveLength(1);
    const later = setup(example, Date.parse(x509.validTo) - 31 * DAY);
    expect((await later.run()).renewed).toBe(false);
  });

  test("a key that does not match cert.pem is reissued", async () => {
    cache({ cert: example.cert, key: other.key });
    const s = setup(example);
    expect((await s.run()).renewed).toBe(true);
    expect(s.calls).toHaveLength(1);
    expect(readFileSync(join(dir, "key.pem"), "utf8")).toBe(example.key);
  });

  test("an unreadable cert.pem is reissued", async () => {
    writeFileSync(join(dir, "cert.pem"), "garbage");
    writeFileSync(join(dir, "key.pem"), example.key);
    const s = setup(example);
    expect((await s.run()).renewed).toBe(true);
    expect(s.calls).toHaveLength(1);
    expect(onDisk()).toBe(example.cert);
  });
});

test("acmeIssuer answers the http-01 challenge", async () => {
  const challenges = new ChallengeStore();
  const seen: (string | undefined)[] = [];
  let clientOpts: unknown;
  const fakeAcme = {
    crypto: {
      createPrivateKey: async () => Buffer.from("ACCOUNT KEY"),
      createCsr: async (data: unknown) => {
        expect(data).toEqual({
          commonName: "example.test",
          altNames: ["example.test", "www.example.test"],
        });
        return [Buffer.from(example.key), Buffer.from("CSR")];
      },
    },
    Client: class {
      constructor(opts: unknown) {
        clientOpts = opts;
      }
      async auto(opts: Record<string, unknown>) {
        expect(opts.termsOfServiceAgreed).toBe(true);
        expect(opts.challengePriority).toEqual(["http-01"]);
        expect(opts).not.toHaveProperty("email");
        expect(String(opts.csr)).toBe("CSR");
        const challenge = { token: "tok" };
        const create = opts.challengeCreateFn as Function;
        const remove = opts.challengeRemoveFn as Function;
        await create({}, challenge, "tok.thumb");
        seen.push(challenges.get("tok"));
        await remove({}, challenge, "tok.thumb");
        seen.push(challenges.get("tok"));
        return example.cert;
      }
    },
  } as unknown as typeof import("acme-client");
  const accountKeyPath = join(dir, "cache", "account.pem");
  const issuer = acmeIssuer(
    { directoryUrl: "https://acme.test/directory", accountKeyPath },
    fakeAcme,
  );
  const hosts = ["example.test", "www.example.test"];
  expect(await issuer.issue(hosts, challenges)).toEqual(example);
  expect(seen).toEqual(["tok.thumb", undefined]);
  expect(clientOpts).toEqual({
    directoryUrl: "https://acme.test/directory",
    accountKey: "ACCOUNT KEY",
  });
  expect(readFileSync(accountKeyPath, "utf8")).toBe("ACCOUNT KEY");
});

test("acmeHttpHandler serves challenges and redirects", async () => {
  const challenges = new ChallengeStore();
  challenges.set("tok", "tok.thumb");
  const handler = acmeHttpHandler(challenges);
  const challenge = handler(
    new Request("http://example.test/.well-known/acme-challenge/tok"),
  );
  expect(challenge.status).toBe(200);
  expect(challenge.headers.get("content-type")).toBe("text/plain");
  expect(await challenge.text()).toBe("tok.thumb");
  expect(
    handler(new Request("http://example.test/.well-known/acme-challenge/x"))
      .status,
  ).toBe(404);
  const redirect = handler(new Request("http://example.test:8080/a?b=1"));
  expect(redirect.status).toBe(302);
  expect(redirect.headers.get("location")).toBe("https://example.test/a?b=1");
  const post = handler(
    new Request("http://example.test/a", { method: "POST" }),
  );
  expect(post.status).toBe(400);
  expect(await post.text()).toBe("Use HTTPS");
});

const peerSubject = (server: { url: string }) =>
  new Promise<string>((resolve, reject) => {
    const port = Number(new URL(server.url).port);
    const socket = connect(
      { host: "127.0.0.1", port, rejectUnauthorized: false },
      () => {
        resolve(socket.getPeerCertificate().subject.CN as string);
        socket.end();
      },
    );
    socket.on("error", reject);
  });

describe("serve with tls", () => {
  const start = async () => {
    const app = testApp({ argv: [] });
    const server = await serve(app, {
      host: "127.0.0.1",
      port: 0,
      tls: example,
      wwwRedirects: ["www.example.test"],
    });
    return {
      server,
      close: async () => {
        await server.stop();
        app.close();
      },
    };
  };

  test("serve with tls answers over https and www redirects", async () => {
    const { server, close } = await start();
    try {
      expect(server.url).toStartWith("https://127.0.0.1:");
      const tls = { rejectUnauthorized: false };
      const ok = await fetch(`${server.url}/api/health`, { tls });
      expect(ok.status).toBe(200);
      const www = await fetch(`${server.url}/api/health`, {
        tls,
        redirect: "manual",
        headers: { host: "www.example.test" },
      });
      expect(www.status).toBe(307);
      expect(www.headers.get("location")).toBe(
        "https://example.test/api/health",
      );
    } finally {
      await close();
    }
  });

  test("setCertificate swaps the served certificate", async () => {
    const { server, close } = await start();
    try {
      expect(await peerSubject(server)).toBe("example.test");
      await server.setCertificate(other);
      expect(await peerSubject(server)).toBe("other.test");
      const res = await fetch(`${server.url}/api/health`, {
        tls: { rejectUnauthorized: false },
      });
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });

  test("a rejected certificate keeps the old one served", async () => {
    const { server, close } = await start();
    try {
      const broken = { cert: other.cert, key: "not a key" };
      await expect(server.setCertificate(broken)).rejects.toThrow();
      expect(await peerSubject(server)).toBe("example.test");
    } finally {
      await close();
    }
  });

  test("stop during a certificate swap leaves no listener", async () => {
    const { server, close } = await start();
    const swapped = server.setCertificate(other);
    await close();
    await swapped;
    expect(await peerSubject(server).catch(() => "down")).toBe("down");
  });
});
