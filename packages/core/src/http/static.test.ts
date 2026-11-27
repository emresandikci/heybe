import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { App, AppOptions } from "../app";
import type { UIExtension } from "../hooks/events";
import { testApp } from "../test-app";
import { serve } from "./server";
import { DASHBOARD_CSP } from "./static";

const CACHE = "max-age=1209600, stale-while-revalidate=86400";
const NOT_FOUND = { data: {}, message: "File not found.", status: 404 };

let root: string;
let dist: string;
let app: App | undefined;
let stop: (() => Promise<void>) | undefined;
let source: "dir" | "map" = "dir";

const write = (path: string, content: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hb-static-"));
  dist = join(root, "dist");
  write(join(dist, "index.html"), "<p>dashboard</p>");
  write(join(dist, "assets/app.js"), "console.log(1)");
  write(join(dist, "sub/index.html"), "<p>sub</p>");
});

afterEach(async () => {
  await stop?.();
  app?.close();
  stop = app = undefined;
  rmSync(root, { recursive: true, force: true });
  mock.restore();
});

async function start(
  opts: AppOptions = {},
  extensions: UIExtension[] = [],
  prepare?: (app: App) => void,
): Promise<string> {
  const dashboard: AppOptions =
    source === "dir"
      ? { dashboardDir: dist }
      : { dashboardDir: join(root, "none"), dashboardFiles: filesOf(dist) };
  app = testApp({ ...dashboard, ...opts });
  prepare?.(app);
  app.onServe((e) => {
    e.uiExtensions.push(...extensions);
    return e.next();
  });
  const server = await serve(app, { host: "127.0.0.1", port: 0 });
  stop = server.stop;
  return server.url;
}

const filesOf = (dir: string) =>
  new Map(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((f) => f.isFile())
      .map((f) => {
        const path = join(f.parentPath, f.name);
        return [path.slice(dir.length + 1), path];
      }),
  );

const get = (url: string) => fetch(url, { redirect: "manual" });

describe.each(["dir", "map"] as const)("dashboard from a %s", (kind) => {
  beforeEach(() => {
    source = kind;
  });
  afterEach(() => {
    source = "dir";
  });

  test("GET /_/ serves index.html with the CSP and no cache header", async () => {
    const res = await get(`${await start()}/_/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>dashboard</p>");
    expect(res.headers.get("content-security-policy")).toBe(DASHBOARD_CSP);
    expect(res.headers.get("cache-control")).toBeNull();
  });

  test("GET /_/assets/app.js is cached outside dev mode", async () => {
    const res = await fetch(`${await start()}/_/assets/app.js`, {
      headers: { "accept-encoding": "identity" },
    });
    expect(await res.text()).toBe("console.log(1)");
    expect(res.headers.get("content-length")).toBe("14");
    expect(res.headers.get("content-type")).toStartWith("text/javascript");
    expect(res.headers.get("cache-control")).toBe(CACHE);
    await stop!();
    app!.close();

    const dev = await get(`${await start({ dev: true })}/_/assets/app.js`);
    expect(dev.status).toBe(200);
    expect(dev.headers.get("cache-control")).toBeNull();
  });

  test("serves gzip when accepted and plain otherwise", async () => {
    const url = `${await start()}/_/assets/app.js`;
    const raw = (encoding: string) =>
      fetch(url, {
        headers: { "accept-encoding": encoding },
        decompress: false,
      });
    const zipped = await raw("gzip");
    expect(zipped.headers.get("content-encoding")).toBe("gzip");
    expect(zipped.headers.get("vary")).toContain("Accept-Encoding");
    expect(gunzipSync(await zipped.bytes()).toString()).toBe("console.log(1)");

    const plain = await raw("identity");
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(plain.headers.get("vary")).toContain("Accept-Encoding");
    expect(await plain.text()).toBe("console.log(1)");
  });

  test("gzip responses carry the plain headers and skip ranges", async () => {
    const url = `${await start()}/_/assets/app.js`;
    const raw = (headers: Record<string, string>) =>
      fetch(url, { headers, decompress: false });
    const zipped = await raw({ "accept-encoding": "gzip" });
    const plain = await raw({ "accept-encoding": "identity" });
    const keys = (r: Response) => [...r.headers.keys()].sort();
    expect(keys(zipped)).toEqual([...keys(plain), "content-encoding"].sort());
    const ranged = await raw({ "accept-encoding": "gzip", range: "bytes=0-3" });
    expect(ranged.headers.get("content-encoding")).toBeNull();
  });

  test("a directory without index.html is a 404 with gzip accepted", async () => {
    const res = await fetch(`${await start()}/_/assets/`, {
      headers: { "accept-encoding": "gzip" },
      redirect: "manual",
    });
    expect(res.status).toBe(404);
  });

  test("GET /_ redirects to /_/", async () => {
    const res = await get(`${await start()}/_`);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/_/");
  });

  test("GET /_/index.html redirects to /_/", async () => {
    const res = await get(`${await start()}/_/index.html`);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/_/");
  });

  test("GET /_/sub redirects to /_/sub/ and a file URL loses its trailing slash", async () => {
    const url = await start();
    const dir = await get(`${url}/_/sub`);
    expect(dir.status).toBe(301);
    expect(dir.headers.get("location")).toBe("/_/sub/");
    expect(await (await get(`${url}/_/sub/`)).text()).toBe("<p>sub</p>");

    const file = await get(`${url}/_/assets/app.js/`);
    expect(file.status).toBe(301);
    expect(file.headers.get("location")).toBe("/_/assets/app.js");
  });

  test("missing files and traversal answer 404", async () => {
    write(join(root, "data.db"), "secret");
    const url = await start();
    for (const path of [
      "/_/nope.js",
      "/_/..%2fdata.db",
      "/_/%2e%2e/%2e%2e/package.json",
    ]) {
      const res = await get(url + path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    }
  });

  test("no dist means no /_/ and no extension routes", async () => {
    rmSync(join(dist, "index.html"));
    const url = await start({}, [{ name: "a", dir: dist }]);
    for (const path of ["/_/", "/_/extensions.js", "/_/extensions/a/sub/"]) {
      const res = await get(url + path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-security-policy")).toBeNull();
    }
  });

  test("static successes are not logged, a 404 is", async () => {
    const url = await start();
    expect((await get(`${url}/_/`)).status).toBe(200);
    expect((await get(`${url}/_/assets/app.js`)).status).toBe(200);
    expect((await get(`${url}/_/nope.js`)).status).toBe(404);
    await app!.logger.flush();
    const rows = app!.auxDb.query<{ message: string }>(
      "SELECT message FROM _logs",
    );
    expect(rows.map((r) => r.message)).toEqual(["GET /_/nope.js"]);
  });
});

test("a map source answers 404 for keys it does not have even if the file exists on disk", async () => {
  const url = await start({
    dashboardDir: dist,
    dashboardFiles: new Map([["index.html", join(dist, "index.html")]]),
  });
  expect(await (await get(`${url}/_/`)).text()).toBe("<p>dashboard</p>");
  const res = await get(`${url}/_/assets/app.js`);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual(NOT_FOUND);
});

describe("UI extensions", () => {
  const ext = (name: string, main?: string): UIExtension => {
    const dir = join(root, "ext", name || "unnamed");
    write(join(dir, "files/style.css"), `.${name} {}`);
    if (main !== undefined) write(join(dir, "main.js"), main);
    return { name, dir };
  };

  test("extensions.js wraps each main.js in order and skips one without main.js", async () => {
    const url = await start({}, [ext("b", "B"), ext("c"), ext("a", "A")]);
    const res = await get(`${url}/_/extensions.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript");
    expect(res.headers.get("content-security-policy")).toBe(DASHBOARD_CSP);
    expect(res.headers.get("cache-control")).toBe(CACHE);
    expect(await res.text()).toBe(
      "await (async function(){B})();await (async function(){A})();",
    );

    writeFileSync(join(root, "ext/a/main.js"), "A2");
    expect(await (await get(`${url}/_/extensions.js`)).text()).toBe(
      "await (async function(){B})();await (async function(){A2})();",
    );
    await app!.logger.flush();
    expect(app!.auxDb.query("SELECT id FROM _logs")).toHaveLength(0);
  });

  test("extension files are served under /_/extensions/<name>/", async () => {
    const url = await start({}, [ext("a", "A")]);
    const res = await get(`${url}/_/extensions/a/files/style.css`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(".a {}");
    expect(res.headers.get("content-security-policy")).toBe(DASHBOARD_CSP);
    expect(res.headers.get("cache-control")).toBe(CACHE);
    expect((await get(`${url}/_/extensions/a/nope.css`)).status).toBe(404);
  });

  test("an extension with an empty name is skipped", async () => {
    const invalid = ext("", "X");
    let debug: ReturnType<typeof spyOn> | undefined;
    const url = await start({}, [invalid, ext("a", "A")], (a) => {
      debug = spyOn(a.logger, "debug");
    });
    expect(debug).toHaveBeenCalledWith("Invalid UI extension configuration", {
      extension: invalid,
    });
    expect(await (await get(`${url}/_/extensions.js`)).text()).toBe(
      "await (async function(){A})();",
    );
  });
});

describe("serve banner", () => {
  async function banner(opts: AppOptions): Promise<string[]> {
    const lines: string[] = [];
    const cli = testApp({ argv: ["serve", "--http", "127.0.0.1:0"], ...opts });
    const printed = new Promise<void>((resolve) => {
      spyOn(console, "log").mockImplementation((line: string) => {
        lines.push(String(line).replace(/http:\/\/[^/]+/, "<url>"));
        if (String(line).startsWith("> REST API:")) resolve();
      });
    });
    const done = cli.start();
    await printed;
    process.emit("SIGINT");
    expect(await done).toBe(0);
    return lines.slice(0, lines.findIndex((l) => l.startsWith("> REST")) + 1);
  }

  test("serve prints the dashboard line only when dist exists", async () => {
    expect(await banner({ dashboardDir: dist })).toEqual([
      "Server started at <url>",
      "> Dashboard: <url>/_/",
      "> REST API:  <url>/api/",
    ]);
    expect(await banner({ dashboardDir: join(root, "none") })).toEqual([
      "Server started at <url>",
      "> REST API:  <url>/api/",
    ]);
  });
});
