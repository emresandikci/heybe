import { afterEach, expect, spyOn, test } from "bun:test";
import { createDashboardClient } from "./client";
import { createExtensionRegistry, loadExtensions } from "./extensions";

const client = createDashboardClient();
const mount = () => {};

afterEach(() => {
  delete window.heybe;
  document.head.querySelectorAll("script").forEach((s) => s.remove());
});

test("invalid and duplicate paths throw", () => {
  const api = createExtensionRegistry().api(client);
  for (const path of ["", "/x", "A", "a//b", "a b"])
    expect(() => api.addPage({ path, title: "T", mount })).toThrow(
      `Invalid extension page path "${path}".`,
    );
  api.addPage({ path: "a/b-1", title: "T", mount });
  expect(() => api.addPage({ path: "a/b-1", title: "T", mount })).toThrow(
    'Extension page "a/b-1" is already registered.',
  );
});

test("registering after freeze throws", () => {
  const registry = createExtensionRegistry();
  const api = registry.api(client);
  registry.freeze();
  const message =
    "Dashboard extensions must be registered while extensions.js loads.";
  expect(() => api.addPage({ path: "a", title: "T", mount })).toThrow(message);
  expect(() => api.addLink({ label: "L", href: "https://x.test" })).toThrow(
    message,
  );
});

test("loadExtensions resolves and freezes when the script errors", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const registry = createExtensionRegistry();
  const loading = loadExtensions(registry, client);
  expect(window.heybe?.dashboard.client).toBe(client);
  const script = document.querySelector<HTMLScriptElement>(
    'script[src$="/_/extensions.js"]',
  )!;
  expect(script.type).toBe("module");
  script.dispatchEvent(new Event("error"));
  await loading;
  expect(warn).toHaveBeenCalledWith("Failed to load dashboard extensions");
  expect(() =>
    window.heybe!.dashboard.addLink({ label: "L", href: "https://x.test" }),
  ).toThrow("registered while extensions.js loads");
  warn.mockRestore();
});

test("loadExtensions resolves and freezes when the script loads", async () => {
  const registry = createExtensionRegistry();
  const loading = loadExtensions(registry, client, "/_/extensions.js");
  window.heybe!.dashboard.addLink({ label: "L", href: "https://x.test" });
  document.querySelector("script")!.dispatchEvent(new Event("load"));
  await loading;
  expect(registry.links).toEqual([{ label: "L", href: "https://x.test" }]);
  expect(() =>
    registry.api(client).addPage({ path: "a", title: "T", mount }),
  ).toThrow();
});
