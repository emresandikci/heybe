import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { Page } from "./Page";

async function renderPage(page: React.ReactElement) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => page }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
}

test("Page renders crumbs as one h1 with links and aria-current", async () => {
  await renderPage(
    <Page
      crumbs={[
        { label: "Settings", to: "/settings" },
        { label: "Application" },
      ]}
      actions={<button>Save</button>}
    >
      body
    </Page>,
  );
  const heading = await screen.findByRole("heading", { level: 1 });
  expect(heading.textContent).toBe("Settings / Application");
  expect(heading.querySelector("a")?.getAttribute("href")).toContain(
    "/settings",
  );
  expect(heading.querySelectorAll("a").length).toBe(1);
  expect(screen.getByText("Application").getAttribute("aria-current")).toBe(
    "page",
  );
  expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
});

test("Page footer shows the version and Docs link", async () => {
  await renderPage(
    <Page crumbs={[{ label: "Logs" }]} footer={<span>left</span>}>
      body
    </Page>,
  );
  expect(await screen.findByText("left")).toBeTruthy();
  expect(screen.getByText(`Heybe v${__HEYBE_VERSION__}`)).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "Docs" }).getAttribute("href"),
  ).toContain("github.com");
});

test("Page crumbs only accept registered routes", () => {
  const crumbs: ComponentProps<typeof Page>["crumbs"] = [
    // @ts-expect-error unknown route
    { label: "Nope", to: "/not-a-route" },
  ];
  expect(crumbs.length).toBe(1);
});
