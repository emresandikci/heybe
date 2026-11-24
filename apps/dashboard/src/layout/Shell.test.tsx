import { expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "../test/render";

test("the shell shows the app name, navigation and the superuser email, and / lands on the first collection", async () => {
  const { router } = renderApp({ path: "/" });
  expect(
    await screen.findByRole("button", { name: "admin@example.com" }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/collections/hbc_posts"),
  );
  const nav = within(screen.getByRole("navigation", { name: "Main" }));
  for (const name of ["Collections", "Superusers", "Logs", "Settings"])
    expect(nav.getByRole("link", { name })).toBeTruthy();
});

test("the sidebar marks the current page", async () => {
  renderApp({ path: "/collections" });
  const link = await screen.findByRole("link", { name: "Collections" });
  expect(link.getAttribute("aria-current")).toBe("page");
  expect(
    screen.getByRole("link", { name: "Logs" }).getAttribute("aria-current"),
  ).toBeNull();
});

test("user menu switches the theme", async () => {
  const { user } = renderApp({ path: "/collections" });
  await user.click(
    await screen.findByRole("button", { name: "admin@example.com" }),
  );
  await user.click(screen.getByRole("menuitemradio", { name: "Dark" }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  await user.click(screen.getByRole("button", { name: "admin@example.com" }));
  await user.click(screen.getByRole("menuitemradio", { name: "Light" }));
  expect(document.documentElement.dataset.theme).toBe("light");
});

test("user menu signs out", async () => {
  const { user, client, router } = renderApp({ path: "/collections" });
  await user.click(
    await screen.findByRole("button", { name: "admin@example.com" }),
  );
  await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  expect(client.authStore.token).toBe("");
});

test("user menu marks the active theme", async () => {
  const { user } = renderApp({ path: "/collections" });
  await user.click(
    await screen.findByRole("button", { name: "admin@example.com" }),
  );
  await user.click(screen.getByRole("menuitemradio", { name: "Dark" }));
  await user.click(screen.getByRole("button", { name: "admin@example.com" }));
  expect(
    screen
      .getByRole("menuitemradio", { name: "Dark" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen
      .getByRole("menuitemradio", { name: "Light" })
      .getAttribute("aria-checked"),
  ).toBe("false");
});

test("the top bar has no breadcrumb", async () => {
  renderApp({ path: "/collections/hbc_posts" });
  await screen.findByRole("button", { name: "admin@example.com" });
  expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
});

test("only Superusers is active on the superusers collection", async () => {
  renderApp({ path: "/collections/hbc_3142635823" });
  const nav = within(await screen.findByRole("navigation", { name: "Main" }));
  await waitFor(() =>
    expect(
      nav
        .getByRole("link", { name: "Superusers" })
        .getAttribute("aria-current"),
    ).toBe("page"),
  );
  expect(
    nav.getByRole("link", { name: "Collections" }).getAttribute("aria-current"),
  ).toBeNull();
});

test("user menu focuses the checked theme", async () => {
  const { user } = renderApp({ path: "/collections" });
  await user.click(
    await screen.findByRole("button", { name: "admin@example.com" }),
  );
  await user.click(screen.getByRole("menuitemradio", { name: "Dark" }));
  await user.click(screen.getByRole("button", { name: "admin@example.com" }));
  expect(document.activeElement).toBe(
    screen.getByRole("menuitemradio", { name: "Dark" }),
  );
});

test("unknown route renders Page not found inside the shell with a link to Collections", async () => {
  renderApp({ path: "/nope" });
  expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe(
    "Page not found",
  );
  expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
  const link = within(screen.getByRole("main")).getByRole("link", {
    name: "Collections",
  });
  expect(link.getAttribute("href")).toContain("/collections");
});

test("the sidebar wordmark and document title follow the app name", async () => {
  renderApp({ path: "/collections" });
  await waitFor(() => expect(document.title).not.toBe(""));
  const name = document.title;
  expect(
    within(screen.getByRole("navigation", { name: "Main" })).getByText(name),
  ).toBeTruthy();
});

test("the menu button opens the navigation drawer, Escape closes it and returns focus to the button", async () => {
  const { user } = renderApp({ path: "/collections" });
  const button = await screen.findByRole("button", { name: "Open menu" });
  await user.click(button);
  const drawer = screen.getByRole("dialog", {
    name: "Menu",
  }) as HTMLDialogElement;
  expect(drawer.open).toBe(true);
  within(drawer).getByRole("link", { name: "Collections" }).focus();
  await user.keyboard("{Escape}");
  expect(drawer.open).toBe(false);
  expect(document.activeElement).toBe(button);
});

test("choosing a link in the navigation drawer closes it", async () => {
  const { user } = renderApp({ path: "/collections/hbc_posts" });
  await user.click(await screen.findByRole("button", { name: "Open menu" }));
  const drawer = screen.getByRole("dialog", {
    name: "Menu",
  }) as HTMLDialogElement;
  await user.click(within(drawer).getByRole("link", { name: "Collections" }));
  await waitFor(() => expect(drawer.open).toBe(false));
});

test("clicking the drawer backdrop closes the navigation drawer", async () => {
  const { user } = renderApp({ path: "/collections" });
  await user.click(await screen.findByRole("button", { name: "Open menu" }));
  const drawer = screen.getByRole("dialog", {
    name: "Menu",
  }) as HTMLDialogElement;
  await user.click(drawer);
  expect(drawer.open).toBe(false);
});
