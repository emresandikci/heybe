import { expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import { fakeServer, type FakeServer } from "../test/fake-server";
import { SUPERUSER, fakeToken, renderApp } from "../test/render";
import { openActions, pickAction } from "./editor-fixtures";

const userRecord = {
  id: "u1",
  collectionId: "_hb_users_auth_",
  collectionName: "users",
  email: "a@b.c",
  emailVisibility: false,
  verified: false,
};

const openUser = async (server: FakeServer = fakeServer(), extra = {}) => {
  server.on("GET", "/api/collections/users/records/:id", {
    ...userRecord,
    ...extra,
  });
  const app = renderApp({
    path: "/collections/_hb_users_auth_?record=u1",
    server,
  });
  await screen.findByRole("dialog", { name: "Edit record" });
  await waitFor(() => expect(screen.queryByText("Loading...")).toBeNull());
  return {
    ...app,
    editor: within(screen.getByRole("dialog", { name: "Edit record" })),
  };
};

const openSelf = async (server: FakeServer = fakeServer()) => {
  server.on("GET", "/api/collections/_superusers/records/:id", {
    ...SUPERUSER,
    emailVisibility: false,
    verified: true,
  });
  const app = renderApp({
    path: "/collections/hbc_3142635823?record=su1",
    server,
  });
  await screen.findByRole("dialog", { name: "Edit record" });
  await waitFor(() => expect(screen.queryByText("Loading...")).toBeNull());
  return {
    ...app,
    editor: within(screen.getByRole("dialog", { name: "Edit record" })),
  };
};

test("send verification posts the record email", async () => {
  const server = fakeServer().on(
    "POST",
    "/api/collections/users/request-verification",
    () => undefined,
  );
  const { user, editor } = await openUser(server);
  await pickAction(user, editor, "Send verification email");
  expect(await screen.findByText("Verification email sent.")).toBeTruthy();
  expect(
    server.find("POST", "/api/collections/users/request-verification")[0]!.body,
  ).toEqual({ email: "a@b.c" });
});

test("send verification is hidden for verified records", async () => {
  const { user, editor } = await openUser(fakeServer(), { verified: true });
  const menu = await openActions(user, editor);
  expect(
    menu.getByRole("menuitem", { name: "Send password reset email" }),
  ).toBeTruthy();
  expect(
    menu.queryByRole("menuitem", { name: "Send verification email" }),
  ).toBeNull();
});

test("send password reset posts the record email", async () => {
  const server = fakeServer().on(
    "POST",
    "/api/collections/users/request-password-reset",
    () => undefined,
  );
  const { user, editor } = await openUser(server);
  await pickAction(user, editor, "Send password reset email");
  expect(await screen.findByText("Password reset email sent.")).toBeTruthy();
  expect(
    server.find("POST", "/api/collections/users/request-password-reset")[0]!
      .body,
  ).toEqual({ email: "a@b.c" });
});

test("impersonate posts duration and shows the token with a copy button", async () => {
  const impersonated = fakeToken({
    id: "u1",
    collectionId: "_hb_users_auth_",
    refreshable: false,
  });
  const server = fakeServer().on(
    "POST",
    "/api/collections/users/impersonate/:id",
    { token: impersonated, record: userRecord },
  );
  const { user, editor, client } = await openUser(server);
  const superuserToken = client.authStore.token;
  await pickAction(user, editor, "Impersonate");
  const dialog = within(
    await screen.findByRole("dialog", { name: "Impersonate a@b.c" }),
  );
  const duration = dialog.getByLabelText("Token duration (seconds)");
  expect((duration as HTMLInputElement).value).toBe("0");
  await user.clear(duration);
  await user.type(duration, "3600");
  await user.click(dialog.getByRole("button", { name: "Generate token" }));
  const token = (await dialog.findByLabelText("Token")) as HTMLInputElement;
  expect(token.value).toBe(impersonated);
  expect(token.readOnly).toBe(true);
  expect(dialog.getByRole("button", { name: "Copy token" })).toBeTruthy();
  expect(dialog.getByText("This token is not refreshable.")).toBeTruthy();
  const [req] = server.find("POST", "/api/collections/users/impersonate/:id");
  expect(req!.path).toBe("/api/collections/users/impersonate/u1");
  expect(req!.body).toEqual({ duration: 3600 });
  expect(req!.headers.get("Authorization")).toBe(superuserToken);
  expect(client.authStore.token).toBe(superuserToken);
  expect(client.authStore.record?.id).toBe("su1");
});

test("impersonate failure shows the server message", async () => {
  const server = fakeServer().on(
    "POST",
    "/api/collections/users/impersonate/:id",
    { code: 400, message: "Impersonation is not allowed.", data: {} },
    400,
  );
  const { user, editor, client } = await openUser(server);
  const superuserToken = client.authStore.token;
  await pickAction(user, editor, "Impersonate");
  const dialog = within(
    await screen.findByRole("dialog", { name: "Impersonate a@b.c" }),
  );
  await user.click(dialog.getByRole("button", { name: "Generate token" }));
  expect((await dialog.findByRole("alert")).textContent).toBe(
    "Impersonation is not allowed.",
  );
  expect(dialog.queryByLabelText("Token")).toBeNull();
  expect(client.authStore.token).toBe(superuserToken);
});

test("auth actions are not shown for new records or base collections", async () => {
  renderApp({ path: "/collections/_hb_users_auth_?record=new" });
  const editor = within(
    await screen.findByRole("dialog", { name: "New record" }),
  );
  expect(editor.queryByRole("button", { name: "More actions" })).toBeNull();
});

test("deleting your own superuser signs you out", async () => {
  const server = fakeServer().on(
    "DELETE",
    "/api/collections/_superusers/records/:id",
    () => undefined,
  );
  const { user, editor, client, router } = await openSelf(server);
  const listed = server.find(
    "GET",
    "/api/collections/_superusers/records",
  ).length;
  await pickAction(user, editor, "Delete");
  const confirm = await screen.findByRole("dialog", { name: "Delete record" });
  await user.click(within(confirm).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  expect(client.authStore.token).toBe("");
  expect(
    server.find("DELETE", "/api/collections/_superusers/records/:id"),
  ).toHaveLength(1);
  expect(
    server.find("GET", "/api/collections/_superusers/records"),
  ).toHaveLength(listed);
});

test("changing your own password signs you out after save", async () => {
  const server = fakeServer().on(
    "PATCH",
    "/api/collections/_superusers/records/:id",
    { ...SUPERUSER },
  );
  const { user, editor, client, router } = await openSelf(server);
  const listed = server.find(
    "GET",
    "/api/collections/_superusers/records",
  ).length;
  await user.click(editor.getByLabelText("Change password"));
  await user.type(editor.getByLabelText("Password"), "secret123");
  await user.type(editor.getByLabelText("Confirm password"), "secret123");
  await user.click(editor.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  expect(client.authStore.token).toBe("");
  expect(
    server.find("PATCH", "/api/collections/_superusers/records/:id")[0]!.body,
  ).toEqual({ password: "secret123", passwordConfirm: "secret123" });
  expect(
    server.find("GET", "/api/collections/_superusers/records"),
  ).toHaveLength(listed);
});

test("saving your own record without a new password keeps you signed in", async () => {
  const server = fakeServer().on(
    "PATCH",
    "/api/collections/_superusers/records/:id",
    { ...SUPERUSER },
  );
  const { user, editor, client, router } = await openSelf(server);
  await user.click(editor.getByLabelText("emailVisibility"));
  await user.click(editor.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("Record saved.")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/collections/hbc_3142635823");
  expect(client.authStore.token).not.toBe("");
});

test("Superusers link opens the _superusers records", async () => {
  const { user, router, server } = renderApp({ path: "/collections" });
  await user.click(await screen.findByRole("link", { name: "Superusers" }));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/collections/hbc_3142635823"),
  );
  await waitFor(() =>
    expect(
      server.find("GET", "/api/collections/_superusers/records").length,
    ).toBeGreaterThan(0),
  );
});

test("email actions are hidden when the record has no email", async () => {
  const { user, editor } = await openUser(fakeServer(), { email: "" });
  const menu = await openActions(user, editor);
  expect(menu.getByRole("menuitem", { name: "Impersonate" })).toBeTruthy();
  expect(
    menu.queryByRole("menuitem", { name: "Send verification email" }),
  ).toBeNull();
  expect(
    menu.queryByRole("menuitem", { name: "Send password reset email" }),
  ).toBeNull();
});

test("password reset is hidden when password auth is disabled", async () => {
  const { users } = await import("./editor-fixtures");
  const { serveCollections } = await import("../test/editor");
  const server = fakeServer();
  serveCollections(server, [
    { ...users(), passwordAuth: { enabled: false, identityFields: [] } },
  ]);
  const { user, editor } = await openUser(server);
  const menu = await openActions(user, editor);
  expect(
    menu.getByRole("menuitem", { name: "Send verification email" }),
  ).toBeTruthy();
  expect(
    menu.queryByRole("menuitem", { name: "Send password reset email" }),
  ).toBeNull();
});

test("impersonate rejects a non-integer duration inline", async () => {
  const { user, editor, server } = await openUser();
  await pickAction(user, editor, "Impersonate");
  const dialog = within(
    await screen.findByRole("dialog", { name: "Impersonate a@b.c" }),
  );
  const duration = dialog.getByLabelText("Token duration (seconds)");
  await user.clear(duration);
  await user.type(duration, "1.5");
  await user.click(dialog.getByRole("button", { name: "Generate token" }));
  expect(duration.getAttribute("aria-invalid")).toBe("true");
  expect(
    dialog.getByText("Enter a whole number of seconds, 0 or more."),
  ).toBeTruthy();
  expect(
    server.find("POST", "/api/collections/users/impersonate/:id"),
  ).toHaveLength(0);
});
