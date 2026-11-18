import { expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { renderApp } from "../test/render";

test("the active collection is marked and edit stays reachable by name", async () => {
  renderApp({ path: "/collections/hbc_posts" });
  const nav = within(
    await screen.findByRole("navigation", { name: "Collections" }),
  );
  const link = await nav.findByRole("link", { name: "posts" });
  expect(link.getAttribute("aria-current")).toBe("page");
  expect(
    nav.getByRole("button", { name: "Edit collection posts" }),
  ).toBeTruthy();
});

test("search has a placeholder and New collection is a button", async () => {
  renderApp({ path: "/collections/hbc_posts" });
  const nav = within(
    await screen.findByRole("navigation", { name: "Collections" }),
  );
  expect(nav.getByPlaceholderText("Search collections")).toBeTruthy();
  expect(nav.getByRole("button", { name: "New collection" })).toBeTruthy();
});

test("the System toggle exposes its state", async () => {
  const { user } = renderApp({ path: "/collections/hbc_posts" });
  const toggle = await screen.findByRole("button", { name: "System" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await user.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
});

test("sidebar shows type icons and marks the active collection", async () => {
  renderApp({ path: "/collections/hbc_posts" });
  const nav = within(
    await screen.findByRole("navigation", { name: "Collections" }),
  );
  const posts = await nav.findByRole("link", { name: "posts" });
  expect(posts.querySelector("svg.lucide-database")).toBeTruthy();
  const users = nav.getByRole("link", { name: "users" });
  expect(users.querySelector("svg.lucide-users")).toBeTruthy();
  expect(users.getAttribute("aria-current")).toBeNull();
  expect(
    nav.getByRole("button", { name: "Overview" }).querySelector("svg"),
  ).toBeTruthy();
});

test("search with no match shows No collections match and clears with the button", async () => {
  const { user } = renderApp({ path: "/collections/hbc_posts" });
  const nav = within(
    await screen.findByRole("navigation", { name: "Collections" }),
  );
  await user.type(await nav.findByPlaceholderText("Search collections"), "zzz");
  expect(nav.getByText("No collections match")).toBeTruthy();
  await user.click(nav.getByRole("button", { name: "Clear search" }));
  expect(nav.queryByText("No collections match")).toBeNull();
  expect(nav.queryByRole("button", { name: "Clear search" })).toBeNull();
});

test("the System toggle is locked open while a search is active", async () => {
  const { user } = renderApp({ path: "/collections/hbc_posts" });
  const nav = within(
    await screen.findByRole("navigation", { name: "Collections" }),
  );
  await user.type(
    await nav.findByPlaceholderText("Search collections"),
    "_super",
  );
  const toggle = nav.getByRole("button", {
    name: "System",
  }) as HTMLButtonElement;
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.disabled).toBe(true);
});
