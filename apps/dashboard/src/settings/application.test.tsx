import { expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { fakeServer, type FakeServer } from "../test/fake-server";
import { settingsFixture } from "../test/fixtures";
import { renderApp } from "../test/render";

function echoSettings(server: FakeServer) {
  return server.on("PATCH", "/api/settings", (req) => ({
    ...settingsFixture,
    ...(req.body as object),
  }));
}

const disclose = (user: { click(el: Element): Promise<void> }, name: RegExp) =>
  user.click(screen.getByRole("button", { name }));

async function openApplication(server = echoSettings(fakeServer())) {
  const app = renderApp({ path: "/settings", server });
  await screen.findByLabelText("Application name");
  const save = () =>
    app.user.click(screen.getByRole("button", { name: "Save changes" }));
  const sent = () =>
    server.find("PATCH", "/api/settings").map((r) => r.body as object);
  return { ...app, server, save, sent };
}

test("saving the app name PATCHes only meta", async () => {
  const { user, save, sent } = await openApplication();
  const name = screen.getByLabelText("Application name");
  await user.clear(name);
  await user.type(name, "Acme");
  await save();
  await screen.findByText("Settings saved.");
  expect(sent()).toEqual([
    { meta: { ...settingsFixture.meta, appName: "Acme" } },
  ]);
});

test("rate limit rules add, edit and remove round trip", async () => {
  const { user, save, sent } = await openApplication();
  await disclose(user, /Rate limiting/);
  await user.click(screen.getByRole("switch", { name: "Enable rate limits" }));
  await user.click(screen.getByRole("button", { name: "Add rule" }));
  const row = within(screen.getAllByRole("row")[1]!);
  await user.type(row.getByLabelText("Label"), "/api/");
  await user.selectOptions(row.getByLabelText("Audience"), "@guest");
  await user.clear(row.getByLabelText("Max requests"));
  await user.type(row.getByLabelText("Max requests"), "30");
  await user.clear(row.getByLabelText("Duration (seconds)"));
  await user.type(row.getByLabelText("Duration (seconds)"), "10");
  await save();
  await screen.findByText("Settings saved.");
  expect(sent()[0]).toEqual({
    rateLimits: {
      enabled: true,
      excludedIPs: [],
      rules: [
        { label: "/api/", audience: "@guest", duration: 10, maxRequests: 30 },
      ],
    },
  });

  await user.click(screen.getByRole("button", { name: "Remove rule 1" }));
  await save();
  await screen.findAllByText("Settings saved.");
  expect(sent()[1]).toEqual({
    rateLimits: { enabled: true, excludedIPs: [], rules: [] },
  });
});

test("server error under the rule input", async () => {
  const server = fakeServer().on(
    "PATCH",
    "/api/settings",
    {
      status: 400,
      message: "Failed to save.",
      data: {
        rateLimits: {
          rules: {
            0: { label: { code: "required", message: "Cannot be blank." } },
          },
        },
      },
    },
    400,
  );
  const { user, save } = await openApplication(server);
  await disclose(user, /Rate limiting/);
  await user.click(screen.getByRole("switch", { name: "Enable rate limits" }));
  await user.click(screen.getByRole("button", { name: "Add rule" }));
  await save();
  const label = await screen.findByLabelText("Label");
  expect(label.getAttribute("aria-invalid")).toBe("true");
  expect(
    document.getElementById(label.getAttribute("aria-describedby")!)
      ?.textContent,
  ).toBe("Cannot be blank.");
  expect(screen.getAllByText("Cannot be blank.")).toHaveLength(1);
});

test("an error no input claims shows in the form error list", async () => {
  const server = fakeServer().on(
    "PATCH",
    "/api/settings",
    {
      status: 400,
      message: "Failed to save.",
      data: { logs: { minLevel: { code: "x", message: "Out of range." } } },
    },
    400,
  );
  const { user, save } = await openApplication(server);
  await user.type(screen.getByLabelText("Application name"), "x");
  await save();
  expect(await screen.findByText("logs.minLevel: Out of range.")).toBeTruthy();
});

test("the accent color field is gone", async () => {
  await openApplication();
  expect(screen.queryByLabelText("Accent color")).toBeNull();
});

test("Reset restores loaded values", async () => {
  const { user } = await openApplication();
  await user.type(screen.getByLabelText("Application name"), "zzz");
  await user.click(
    screen.getByRole("switch", { name: "Hide collection controls" }),
  );
  await user.click(screen.getByRole("button", { name: "Reset" }));
  expect(
    (screen.getByLabelText("Application name") as HTMLInputElement).value,
  ).toBe("Heybe");
  expect(
    screen
      .getByRole("switch", { name: "Hide collection controls" })
      .getAttribute("aria-checked"),
  ).toBe("false");
});

test("list inputs send one entry per comma and skip blanks", async () => {
  const { user, save, sent } = await openApplication();
  await disclose(user, /Superuser IPs/);
  await user.type(screen.getByLabelText("Allowed IPs"), "10.0.0.1, ,10.0.0.2");
  await save();
  await screen.findByText("Settings saved.");
  expect(sent()).toEqual([{ superuserIPs: ["10.0.0.1", "10.0.0.2"] }]);
});

test("the settings nav hides Import collections with hideControls", async () => {
  const server = fakeServer().on("GET", "/api/settings", {
    ...settingsFixture,
    meta: { ...settingsFixture.meta, hideControls: true },
  });
  renderApp({ path: "/settings", server });
  await screen.findByLabelText("Application name");
  const nav = within(screen.getByRole("navigation", { name: "Settings" }));
  expect(nav.getByRole("link", { name: "Mail" })).toBeTruthy();
  expect(nav.queryByRole("link", { name: "Import collections" })).toBeNull();
});

test("per-item errors show next to the list input", async () => {
  const server = fakeServer().on(
    "PATCH",
    "/api/settings",
    {
      status: 400,
      message: "Failed to save.",
      data: {
        superuserIPs: { 1: { code: "x", message: "Invalid IP." } },
      },
    },
    400,
  );
  const { user, save } = await openApplication(server);
  await disclose(user, /Superuser IPs/);
  await user.type(screen.getByLabelText("Allowed IPs"), "10.0.0.1,bad");
  await save();
  expect(await screen.findByText("Item 2: Invalid IP.")).toBeTruthy();
  expect(screen.queryByText("superuserIPs.1: Invalid IP.")).toBeNull();
});

test("decimals in integer inputs are truncated", async () => {
  const { user, save, sent } = await openApplication();
  await disclose(user, /Batch API/);
  const input = screen.getByLabelText("Max requests");
  await user.clear(input);
  await user.type(input, "7.9");
  await save();
  await screen.findByText("Settings saved.");
  expect(sent()).toEqual([
    { batch: { ...settingsFixture.batch, maxRequests: 7 } },
  ]);
});

test("clearing an integer input stays empty and sends 0", async () => {
  const { user, save, sent } = await openApplication();
  await disclose(user, /Batch API/);
  const input = screen.getByLabelText("Max requests") as HTMLInputElement;
  await user.clear(input);
  expect(input.value).toBe("");
  await save();
  await screen.findByText("Settings saved.");
  expect(sent()).toEqual([
    { batch: { ...settingsFixture.batch, maxRequests: 0 } },
  ]);
});

test("a background refetch keeps a dirty draft", async () => {
  const { user, queryClient } = await openApplication();
  await user.type(screen.getByLabelText("Application name"), "zzz");
  await queryClient.invalidateQueries({ queryKey: ["settings"] });
  expect(
    (screen.getByLabelText("Application name") as HTMLInputElement).value,
  ).toBe("Heybezzz");
});

test("the rate limit rules are disabled while rate limits are off", async () => {
  const { user } = await openApplication();
  await disclose(user, /Rate limiting/);
  const group = screen
    .getByRole("button", { name: "Add rule" })
    .closest("fieldset") as HTMLFieldSetElement;
  expect(group.disabled).toBe(true);
  await user.click(screen.getByRole("switch", { name: "Enable rate limits" }));
  expect(group.disabled).toBe(false);
});

test("leaving with unsaved settings asks first", async () => {
  const { user, router } = await openApplication();
  await user.type(screen.getByLabelText("Application name"), "x");
  await user.click(screen.getByRole("link", { name: "Mail" }));
  const ask = await screen.findByRole("dialog", {
    name: "Discard unsaved changes?",
  });
  await user.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(router.state.location.pathname).toBe("/settings");
  await user.click(screen.getByRole("link", { name: "Mail" }));
  await user.click(
    within(
      await screen.findByRole("dialog", { name: "Discard unsaved changes?" }),
    ).getByRole("button", { name: "Discard" }),
  );
  await screen.findByLabelText("Sender address");
});
