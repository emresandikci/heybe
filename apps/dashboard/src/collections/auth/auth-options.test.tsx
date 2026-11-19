import { expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import { fakeServer, type FakeServer } from "../../test/fake-server";
import {
  completionLabels,
  echoPatch,
  openEditor,
  serveCollections,
  paste,
} from "../../test/editor";
import { collectionsFixture, scaffoldsFixture } from "../../test/fixtures";
import { renderApp } from "../../test/render";

const users = collectionsFixture.find((c) => c.name === "users")!;
const openSection = (name: string) => {
  const button = screen.getByRole("button", { name });
  if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
  return document.getElementById(button.getAttribute("aria-controls")!)!;
};
const region = (name: string) => within(openSection(name));
const group = (name: string, section: string) => {
  openSection(section);
  return within(screen.getByRole("group", { name }));
};

async function openOptions(name = "users", server = fakeServer()) {
  echoPatch(server, users);
  const app = await openEditor(name, server);
  await app.user.click(within(app.dialog).getByRole("tab", { name: "Auth" }));
  const saved = async () => {
    await app.save();
    await screen.findByText("Collection saved.");
    const [patch] = server.find("PATCH", "/api/collections/:id");
    return patch!.body as Record<string, any>;
  };
  return { ...app, server, saved };
}

async function addProvider(
  user: Awaited<ReturnType<typeof openOptions>>["user"],
  name: string,
) {
  const oauth2 = region("OAuth2");
  await user.selectOptions(oauth2.getByLabelText("Provider"), name);
  await user.click(oauth2.getByRole("button", { name: "Add provider" }));
}

const providerDialog = (title: string) =>
  within(screen.getByRole("dialog", { name: title }));

test("adding a provider sends name, clientId, clientSecret and pkce", async () => {
  const { user, saved } = await openOptions();
  await addProvider(user, "github");
  const dialog = providerDialog("GitHub provider");
  await user.type(dialog.getByLabelText("Client ID"), "gh-id");
  await user.type(dialog.getByLabelText("Client secret"), "gh-secret");
  await user.selectOptions(dialog.getByLabelText("PKCE"), "on");
  await user.click(dialog.getByRole("button", { name: "Apply" }));
  expect(region("OAuth2").getByText("GitHub")).toBeTruthy();
  const body = await saved();
  expect(body.oauth2.providers[1]).toMatchObject({
    name: "github",
    clientId: "gh-id",
    clientSecret: "gh-secret",
    pkce: true,
  });
});

test("editing a provider without typing a secret sends no clientSecret key", async () => {
  const { user, saved } = await openOptions();
  await user.click(
    region("OAuth2").getByRole("button", { name: "Edit provider Google" }),
  );
  const dialog = providerDialog("Google provider");
  expect(
    dialog.getByText("Leave empty to keep the current value"),
  ).toBeTruthy();
  const id = dialog.getByLabelText("Client ID");
  await user.clear(id);
  await user.type(id, "new-id");
  await user.click(dialog.getByRole("button", { name: "Apply" }));
  const [google] = (await saved()).oauth2.providers;
  expect(google).toMatchObject({ name: "google", clientId: "new-id" });
  expect(google).not.toHaveProperty("clientSecret");
});

test("removing a provider drops it", async () => {
  const { user, saved } = await openOptions();
  await user.click(
    region("OAuth2").getByRole("button", { name: "Remove provider Google" }),
  );
  expect((await saved()).oauth2.providers).toEqual([]);
});

test("a provider without default endpoints asks for them", async () => {
  const { user } = await openOptions();
  await addProvider(user, "oidc");
  const dialog = providerDialog("OpenID Connect provider");
  for (const label of ["Auth URL", "Token URL", "User info URL"])
    expect((dialog.getByLabelText(label) as HTMLInputElement).required).toBe(
      true,
    );
});

test("apple generate fills clientSecret from the response", async () => {
  const server = fakeServer().on(
    "POST",
    "/api/settings/apple/generate-client-secret",
    { secret: "apple-secret" },
  );
  const { user, saved } = await openOptions("users", server);
  await addProvider(user, "apple");
  const dialog = providerDialog("Apple provider");
  await paste(user, dialog.getByLabelText("Client ID"), "com.example");
  await user.type(dialog.getByLabelText("Team ID"), "TEAM");
  await user.type(dialog.getByLabelText("Key ID"), "KEY");
  await user.type(dialog.getByLabelText("Private key"), "PK");
  await user.click(
    dialog.getByRole("button", { name: "Generate client secret" }),
  );
  await dialog.findByDisplayValue("apple-secret");
  expect(
    server.find("POST", "/api/settings/apple/generate-client-secret")[0]!.body,
  ).toEqual({
    clientId: "com.example",
    teamId: "TEAM",
    keyId: "KEY",
    privateKey: "PK",
    duration: 15777000,
  });
  await user.click(dialog.getByRole("button", { name: "Apply" }));
  expect((await saved()).oauth2.providers[1]).toMatchObject({
    name: "apple",
    clientSecret: "apple-secret",
  });
});

test("invalidate sets a new 50 character secret on authToken only", async () => {
  const { user, saved } = await openOptions();
  await user.click(
    group("Auth token", "Tokens").getByRole("button", {
      name: "Invalidate all issued tokens",
    }),
  );
  const body = await saved();
  expect(body.authToken.secret).toMatch(/^[a-zA-Z0-9]{50}$/);
  expect(body.authToken.duration).toBe(604800);
  for (const key of [
    "passwordResetToken",
    "emailChangeToken",
    "verificationToken",
    "fileToken",
  ])
    expect(body[key]).not.toHaveProperty("secret");
});

test("otp, mfa and passwordAuth round trip in the PATCH body", async () => {
  const { user, saved } = await openOptions();
  await user.click(
    region("Password auth").getByRole("checkbox", { name: "username" }),
  );
  const otp = region("One-time password");
  await user.click(otp.getByLabelText("Enable one-time password"));
  const length = otp.getByLabelText("OTP length");
  await user.clear(length);
  await user.type(length, "6");
  const mfa = region("Multi-factor auth");
  await user.click(mfa.getByLabelText("Enable multi-factor auth"));
  await paste(user, mfa.getByLabelText("MFA rule"), "verified = true");
  await user.click(region("Login alerts").getByLabelText("Send login alerts"));
  const body = await saved();
  expect(body.passwordAuth).toEqual({
    enabled: true,
    identityFields: ["email", "username"],
  });
  expect(body.otp).toMatchObject({ enabled: true, duration: 180, length: 6 });
  expect(body.mfa).toEqual({
    enabled: true,
    duration: 1800,
    rule: "verified = true",
  });
  expect(body.authAlert.enabled).toBe(false);
});

test('test email posts collection, email and template "password-reset"', async () => {
  const server = fakeServer().on(
    "POST",
    "/api/settings/test/email",
    () => undefined,
  );
  const { user } = await openOptions("users", server);
  await user.click(
    group("Password reset email", "Email templates").getByRole("button", {
      name: "Send test email",
    }),
  );
  const dialog = providerDialog("Send test email");
  await paste(user, dialog.getByLabelText("Email"), "me@example.com");
  const send = dialog.getByRole("button", { name: "Send" });
  expect(send.closest("[data-part=footer]")).not.toBeNull();
  await user.click(send);
  await screen.findByText("Test email sent.");
  expect(server.find("POST", "/api/settings/test/email")[0]!.body).toEqual({
    collection: "users",
    email: "me@example.com",
    template: "password-reset",
  });
});

test("templates write subject and body", async () => {
  const { user, saved } = await openOptions();
  const verify = group("Verification email", "Email templates");
  await user.clear(verify.getByLabelText("Subject"));
  await user.type(verify.getByLabelText("Subject"), "Hi");
  expect(verify.getByText(/\{RECORD:<field>\}/)).toBeTruthy();
  expect((await saved()).verificationTemplate).toEqual({
    subject: "Hi",
    body: "<p>Verify</p>",
  });
});

test("_superusers hides the OAuth2 section", async () => {
  const { user } = renderApp({ path: "/collections/hbc_3142635823" });
  await user.click(await screen.findByRole("button", { name: "System" }));
  await user.click(
    screen.getByRole("button", { name: "Edit collection _superusers" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Edit _superusers" });
  await user.click(within(dialog).getByRole("tab", { name: "Auth" }));
  expect(openSection("Password auth")).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: "OAuth2" })).toBeNull();
});

test("provider error shows in the dialog", async () => {
  const server: FakeServer = fakeServer().on(
    "PATCH",
    "/api/collections/:id",
    {
      code: 400,
      message: "Failed to update collection.",
      data: {
        oauth2: {
          providers: { 0: { clientId: { message: "Cannot be blank." } } },
        },
      },
    },
    400,
  );
  const app = await openEditor("users", server);
  await app.save();
  const oauth2 = region("OAuth2");
  expect(oauth2.getByText(/Cannot be blank\./)).toBeTruthy();
  await app.user.click(
    oauth2.getByRole("button", { name: "Edit provider Google" }),
  );
  const dialog = providerDialog("Google provider");
  expect(dialog.getByLabelText("Client ID").getAttribute("aria-invalid")).toBe(
    "true",
  );
  expect(dialog.getByText("Cannot be blank.")).toBeTruthy();
  expect(within(app.dialog).queryByRole("alert")).toBeNull();
});

test("leaving the auth type while on Options falls back to Fields", async () => {
  const server = fakeServer().on(
    "GET",
    "/api/collections/meta/scaffolds",
    scaffoldsFixture,
  );
  const { user } = renderApp({ path: "/collections/hbc_posts", server });
  await user.click(
    await screen.findByRole("button", { name: "New collection" }),
  );
  const dialog = within(screen.getByRole("dialog", { name: "New collection" }));
  await user.selectOptions(await dialog.findByLabelText("Type"), "auth");
  await user.click(dialog.getByRole("tab", { name: "Auth" }));
  expect(openSection("Password auth")).toBeTruthy();
  await user.selectOptions(dialog.getByLabelText("Type"), "base");
  expect(
    dialog.getByRole("tab", { name: "Fields" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(dialog.getByLabelText("New field type")).toBeTruthy();
});

test("sending a test email does not save the collection", async () => {
  const server = fakeServer().on(
    "POST",
    "/api/settings/test/email",
    () => undefined,
  );
  const { user } = await openOptions("users", server);
  await user.click(
    group("Password reset email", "Email templates").getByRole("button", {
      name: "Send test email",
    }),
  );
  const dialog = providerDialog("Send test email");
  await paste(user, dialog.getByLabelText("Email"), "me@example.com");
  await user.click(dialog.getByRole("button", { name: "Send" }));
  await screen.findByText("Test email sent.");
  expect(server.find("PATCH", "/api/collections/:id")).toHaveLength(0);
  expect(screen.getByRole("dialog", { name: "Edit users" })).toBeTruthy();
});

test("Enter in a provider dialog does not save the collection", async () => {
  const { user, server } = await openOptions();
  await user.click(
    region("OAuth2").getByRole("button", { name: "Edit provider Google" }),
  );
  await user.type(
    providerDialog("Google provider").getByLabelText("Client ID"),
    "x{Enter}",
  );
  expect(server.find("PATCH", "/api/collections/:id")).toHaveLength(0);
});

test("removing a provider clears index-based provider errors", async () => {
  const two = {
    ...users,
    oauth2: {
      ...(users.oauth2 as object),
      providers: [
        (users.oauth2 as { providers: object[] }).providers[0],
        { name: "github", clientId: "gh" },
      ],
    },
  };
  const server = serveCollections(
    fakeServer(),
    collectionsFixture.map((c) => (c.name === "users" ? two : c)),
  ).on(
    "PATCH",
    "/api/collections/:id",
    {
      code: 400,
      message: "Failed to update collection.",
      data: {
        oauth2: {
          providers: { 0: { clientId: { message: "Cannot be blank." } } },
        },
      },
    },
    400,
  );
  const app = await openEditor("users", server);
  await app.save();
  const oauth2 = region("OAuth2");
  await oauth2.findByText(/Cannot be blank/);
  await app.user.click(
    oauth2.getByRole("button", { name: "Remove provider Google" }),
  );
  expect(region("OAuth2").queryByText(/Cannot be blank/)).toBeNull();
});

test("apple generate errors show on their inputs", async () => {
  const server = fakeServer().on(
    "POST",
    "/api/settings/apple/generate-client-secret",
    {
      code: 400,
      message: "Failed to generate.",
      data: { teamId: { message: "Cannot be blank." } },
    },
    400,
  );
  const { user } = await openOptions("users", server);
  await addProvider(user, "apple");
  const dialog = providerDialog("Apple provider");
  await user.click(
    dialog.getByRole("button", { name: "Generate client secret" }),
  );
  await dialog.findByText("Cannot be blank.");
  expect(dialog.getByLabelText("Team ID").getAttribute("aria-invalid")).toBe(
    "true",
  );
});

test("hidden fields are not offered as identity fields", async () => {
  const withTokenIndex = {
    ...users,
    indexes: [
      ...users.indexes,
      "CREATE UNIQUE INDEX `idx_tokenKey_users` ON `users` (`tokenKey`)",
    ],
  };
  const server = serveCollections(
    fakeServer(),
    collectionsFixture.map((c) => (c.name === "users" ? withTokenIndex : c)),
  );
  await openOptions("users", server);
  const password = region("Password auth");
  expect(password.getByRole("checkbox", { name: "email" })).toBeTruthy();
  expect(password.queryByRole("checkbox", { name: "tokenKey" })).toBeNull();
});

test("Undo keeps the token secret unchanged", async () => {
  const { user, saved } = await openOptions();
  const auth = group("Auth token", "Tokens");
  await user.click(
    auth.getByRole("button", { name: "Invalidate all issued tokens" }),
  );
  await user.click(auth.getByRole("button", { name: "Undo" }));
  expect(
    auth.getByRole("button", { name: "Invalidate all issued tokens" }),
  ).toBeTruthy();
  expect((await saved()).authToken).toEqual({ duration: 604800 });
});

test("the Auth tab starts with the OAuth2 section", async () => {
  const { dialog } = await openOptions();
  expect(within(dialog).queryByRole("tab", { name: "Options" })).toBeNull();
  const first = dialog.querySelector("button[aria-expanded]")!;
  expect(first.textContent).toBe("OAuth2");
});

test("Auth tab sections are disclosures", async () => {
  await openOptions();
  for (const name of [
    "OAuth2",
    "Password auth",
    "One-time password",
    "Multi-factor auth",
    "Login alerts",
    "Tokens",
    "Email templates",
  ])
    expect(
      screen.getByRole("button", { name }).getAttribute("aria-expanded"),
    ).not.toBeNull();
});

test("a collapsed section with a server error opens in place and stays open while typing", async () => {
  const server = fakeServer().on(
    "PATCH",
    "/api/collections/:id",
    {
      code: 400,
      message: "Failed to update collection.",
      data: { otp: { duration: { message: "Too short." } } },
    },
    400,
  );
  const { user, dialog, save } = await openEditor("users", server);
  await user.click(within(dialog).getByRole("tab", { name: "Auth" }));
  const toggle = () =>
    screen.getByRole("button", { name: "One-time password" });
  const before = toggle();
  expect(before.getAttribute("aria-expanded")).toBe("false");
  await save();
  await screen.findByText("Too short.");
  expect(toggle() === before).toBe(true);
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  await user.type(screen.getByLabelText("OTP duration (seconds)"), "1");
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
});

test("the MFA rule suggests request params and fields", async () => {
  await openOptions();
  const mfa = region("Multi-factor auth");
  expect(
    await completionLabels(mfa.getByLabelText("MFA rule"), "@request.auth.ver"),
  ).toContain("@request.auth.verified bool");
});
