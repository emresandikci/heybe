import { expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import { createExtensionRegistry } from "../app/extensions";
import { createDashboardClient } from "../app/client";
import { renderApp } from "../test/render";

function setup(
  register: (
    api: ReturnType<ReturnType<typeof createExtensionRegistry>["api"]>,
  ) => void,
) {
  const extensions = createExtensionRegistry();
  register(extensions.api(createDashboardClient()));
  extensions.freeze();
  return extensions;
}

test("addPage adds a sidebar link and /ext/<path> mounts it with the client", async () => {
  const extensions = setup((api) =>
    api.addPage({
      path: "demo",
      title: "Demo",
      mount(el, { client }) {
        el.textContent = `Demo for ${client.authStore.record?.email}`;
      },
    }),
  );
  const { user } = renderApp({ path: "/settings", extensions });
  await user.click(await screen.findByRole("link", { name: "Demo" }));
  expect(await screen.findByText("Demo for admin@example.com")).toBeTruthy();
  await waitFor(() => expect(document.title).toBe("Demo - Heybe"));
});

test("the cleanup runs when navigating away", async () => {
  let cleaned = 0;
  const extensions = setup((api) =>
    api.addPage({
      path: "demo",
      title: "Demo",
      mount: () => () => void cleaned++,
    }),
  );
  const { user } = renderApp({ path: "/ext/demo", extensions });
  await screen.findByRole("link", { name: "Demo" });
  expect(cleaned).toBe(0);
  await user.click(screen.getByRole("link", { name: "Settings" }));
  await waitFor(() => expect(cleaned).toBe(1));
});

test("an unknown extension path shows not found", async () => {
  renderApp({ path: "/ext/nope", extensions: setup(() => {}) });
  expect(await screen.findByText("Page not found.")).toBeTruthy();
});

test("a throwing extension shows an error and keeps the dashboard working", async () => {
  const extensions = setup((api) =>
    api.addPage({
      path: "bad",
      title: "Bad",
      mount() {
        throw new Error("boom");
      },
    }),
  );
  renderApp({ path: "/ext/bad", extensions });
  expect(await screen.findByText(/boom/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Logs" })).toBeTruthy();
});

test("external links open in a new tab with noopener", async () => {
  const extensions = setup((api) =>
    api.addLink({ label: "Docs", href: "https://docs.example.com" }),
  );
  renderApp({ path: "/settings", extensions });
  const link = await screen.findByRole("link", { name: "Docs" });
  expect(link.getAttribute("href")).toBe("https://docs.example.com");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
});
