import { expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import { renderApp } from "../test/render";

test("the shell shows the app name, navigation and the superuser email, and / lands on collections", async () => {
  const { router } = renderApp({ path: "/" });
  expect(await screen.findByRole("heading", { name: "Heybe" })).toBeTruthy();
  expect(await screen.findByText("admin@example.com")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/collections");
  for (const name of ["Collections", "Logs", "Settings"])
    expect(screen.getByRole("link", { name })).toBeTruthy();
});
