import { expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import type { CollectionModel } from "@heybe/client";
import { echoPatch, serveCollections, setCode } from "../test/editor";
import { fakeServer } from "../test/fake-server";
import { collectionsFixture, settingsFixture } from "../test/fixtures";
import { renderApp } from "../test/render";

const users = collectionsFixture.find((c) => c.name === "users")!;
const off = {
  ...users,
  oauth2: { ...(users.oauth2 as object), enabled: false },
} as CollectionModel;

test("settings nav has groups and marks the active page", async () => {
  renderApp({ path: "/settings/mail", server: fakeServer() });
  const nav = within(
    await screen.findByRole("navigation", { name: "Settings" }),
  );
  for (const group of ["System", "Sync", "Authentication", "Debug"])
    expect(nav.getByText(group)).toBeTruthy();
  const active = nav.getByRole("link", { name: "Mail" });
  expect(active.getAttribute("aria-current")).toBe("page");
  expect(active.className).toContain("bg-hover");
  expect(
    nav.getByRole("link", { name: "Backups" }).getAttribute("aria-current"),
  ).toBeNull();
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "Settings / Mail",
  );
});

test("save disabled until dirty, Reset restores", async () => {
  const { user } = renderApp({ path: "/settings", server: fakeServer() });
  const name = await screen.findByLabelText("Application name");
  const save = screen.getByRole("button", { name: "Save changes" });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  await user.type(name, "x");
  expect((save as HTMLButtonElement).disabled).toBe(false);
  await user.click(screen.getByRole("button", { name: "Reset" }));
  expect(
    (screen.getByLabelText("Application name") as HTMLInputElement).value,
  ).toBe("Heybe");
  expect(
    (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("failed save keeps edits and shows the error by the button", async () => {
  const server = fakeServer().on(
    "PATCH",
    "/api/settings",
    { status: 400, message: "Failed to save.", data: {} },
    400,
  );
  const { user } = renderApp({ path: "/settings", server });
  const name = await screen.findByLabelText("Application name");
  await user.type(name, "x");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  const alert = await screen.findByRole("alert");
  const save = screen.getByRole("button", { name: "Save changes" });
  expect(
    within(screen.getByRole("group", { name: "Form actions" })).getByRole(
      "alert",
    ),
  ).toBe(alert);
  expect((name as HTMLInputElement).value).toBe("Heybex");
  expect((save as HTMLButtonElement).disabled).toBe(false);
});

test("Application secondary settings are disclosures with badges", async () => {
  const { user } = renderApp({ path: "/settings", server: fakeServer() });
  await screen.findByLabelText("Application name");
  const batch = screen.getByRole("button", { name: /Batch API/ });
  expect(batch.getAttribute("aria-expanded")).toBe("false");
  expect(within(batch).getByText("Enabled")).toBeTruthy();
  expect(
    within(screen.getByRole("button", { name: /Rate limiting/ })).getByText(
      "Disabled",
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("button", { name: /Superuser IPs/ })).getByText(
      "Disabled",
    ),
  ).toBeTruthy();
  await user.click(screen.getByRole("button", { name: /Rate limiting/ }));
  await user.click(screen.getByRole("switch", { name: "Enable rate limits" }));
  expect(
    within(screen.getByRole("button", { name: /Rate limiting/ })).getByText(
      "Enabled",
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole("switch", { name: "Hide collection controls" }),
  ).toBeTruthy();
});

test("SMTP settings are a disclosure whose badge follows the switch", async () => {
  const { user } = renderApp({ path: "/settings/mail", server: fakeServer() });
  await screen.findByLabelText("Sender name");
  const smtp = screen.getByRole("button", { name: /SMTP server/ });
  expect(within(smtp).getByText("Disabled")).toBeTruthy();
  await user.click(smtp);
  await user.click(screen.getByRole("switch", { name: "Use SMTP" }));
  expect(within(smtp).getByText("Enabled")).toBeTruthy();
});

test("provider dialog rejects empty client id and secret", async () => {
  const server = serveCollections(fakeServer(), [users]);
  echoPatch(server, users);
  const { user } = renderApp({ path: "/settings/auth-providers", server });
  await user.click(
    await screen.findByRole("button", { name: "Configure GitHub" }),
  );
  const dialog = within(
    screen.getByRole("dialog", { name: "GitHub provider" }),
  );
  await user.click(dialog.getByRole("button", { name: "Save provider" }));
  expect(dialog.getAllByText("Cannot be blank.")).toHaveLength(2);
  expect(server.find("PATCH", "/api/collections/:id")).toHaveLength(0);
});

test("provider badge says Configured when OAuth2 is off", async () => {
  renderApp({
    path: "/settings/auth-providers",
    server: serveCollections(fakeServer(), [off]),
  });
  const list = await screen.findByRole("list", { name: "Enabled providers" });
  expect(within(list).getByText("Configured")).toBeTruthy();
  expect(within(list).queryByText("Enabled")).toBeNull();
});

test("OIDC providers have distinct display names", async () => {
  renderApp({
    path: "/settings/auth-providers",
    server: serveCollections(fakeServer(), [users]),
  });
  for (const name of ["OpenID Connect", "OpenID Connect 2", "OpenID Connect 3"])
    expect(
      await screen.findByRole("button", { name: `Configure ${name}` }),
    ).toBeTruthy();
});

test("enabled provider card keeps its name visible", async () => {
  renderApp({
    path: "/settings/auth-providers",
    server: serveCollections(fakeServer(), [users]),
  });
  const name = await screen.findByText("Google");
  expect(name.className).not.toContain("truncate");
  expect(name.parentElement!.className).toContain("min-w-0");
  expect(name.parentElement!.className).not.toContain("truncate");
});

test("SQL error clears when the query changes", async () => {
  const server = fakeServer().on(
    "POST",
    "/api/sql",
    { status: 400, message: "bad sql", data: {} },
    400,
  );
  const { user } = renderApp({ path: "/settings/sql", server });
  const sql = await screen.findByLabelText("SQL query");
  setCode(sql, "SELECT * FROM x");
  await user.click(screen.getByRole("button", { name: "Run" }));
  expect(await screen.findByText("bad sql")).toBeTruthy();
  setCode(sql, "SELECT 1");
  expect(screen.queryByText("bad sql")).toBeNull();
});

test("crons Run now column is right aligned with a header", async () => {
  const server = fakeServer().on("GET", "/api/crons", () => [
    { id: "job", expression: "0 0 * * *" },
  ]);
  renderApp({ path: "/settings/crons", server });
  const header = await screen.findByRole("columnheader", { name: "Action" });
  expect(header.className).toContain("text-right");
  const cell = screen.getByRole("button", { name: "Run now" }).parentElement!;
  expect(cell.className).toContain("text-right");
});

test("a field error in a collapsed section opens it and shows the error", async () => {
  const server = fakeServer().on(
    "PATCH",
    "/api/settings",
    {
      status: 400,
      message: "Failed to save.",
      data: { smtp: { host: { code: "x", message: "Host is invalid." } } },
    },
    400,
  );
  const { user } = renderApp({ path: "/settings/mail", server });
  await user.type(await screen.findByLabelText("Sender name"), "x");
  const smtp = screen.getByRole("button", { name: /SMTP server/ });
  expect(smtp.getAttribute("aria-expanded")).toBe("false");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("Host is invalid.")).toBeTruthy();
  expect(smtp.getAttribute("aria-expanded")).toBe("true");
});

test("an open section stays open after save", async () => {
  const server = fakeServer().on("PATCH", "/api/settings", (req) => ({
    ...settingsFixture,
    ...(req.body as object),
  }));
  const { user } = renderApp({ path: "/settings", server });
  await user.type(await screen.findByLabelText("Application name"), "x");
  await user.click(screen.getByRole("button", { name: /Batch API/ }));
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Settings saved.");
  expect(
    screen
      .getByRole("button", { name: /Batch API/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(
    (screen.getByLabelText("Application name") as HTMLInputElement).value,
  ).toBe("Heybex");
});
