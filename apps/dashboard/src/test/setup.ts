import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, expect } from "bun:test";

(globalThis as { __HEYBE_VERSION__?: string }).__HEYBE_VERSION__ = "1.2.3";

GlobalRegistrator.register({ url: "http://localhost/_/" });

const { cleanup } = await import("@testing-library/react");
const { createdServers } = await import("./fake-server");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  const unmatched = createdServers
    .splice(0)
    .flatMap((s) => s.unmatched.map((r) => `${r.method} ${r.path}`));
  expect(unmatched).toEqual([]);
});
