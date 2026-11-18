import { expect, spyOn, test } from "bun:test";
import { screen } from "@testing-library/react";
import { fakeServer } from "../../test/fake-server";
import { fakeToken, renderApp } from "../../test/render";

const USERS = "_hb_users_auth_";
const token = fakeToken({ collectionId: USERS });

test("verification confirms once on mount with the token's collection", async () => {
  const server = fakeServer().on(
    "POST",
    `/api/collections/${USERS}/confirm-verification`,
    new Response(null, { status: 204 }),
  );
  renderApp({
    path: `/auth/confirm-verification/${token}`,
    server,
    auth: "none",
  });
  await screen.findByText("Your email address is verified.");
  const calls = server.find(
    "POST",
    `/api/collections/${USERS}/confirm-verification`,
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body).toEqual({ token });
});

test("password reset posts token, password and passwordConfirm", async () => {
  const server = fakeServer().on(
    "POST",
    `/api/collections/${USERS}/confirm-password-reset`,
    new Response(null, { status: 204 }),
  );
  const { user } = renderApp({
    path: `/auth/confirm-password-reset/${token}`,
    server,
    auth: "none",
  });
  await user.type(await screen.findByLabelText("New password"), "newsecret123");
  await user.type(
    screen.getByLabelText("Confirm new password"),
    "newsecret123",
  );
  await user.click(screen.getByRole("button", { name: "Set new password" }));
  await screen.findByText("Your password was changed.");
  const [call] = server.find(
    "POST",
    `/api/collections/${USERS}/confirm-password-reset`,
  );
  expect(call!.body).toEqual({
    token,
    password: "newsecret123",
    passwordConfirm: "newsecret123",
  });
  expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
});

test("superuser password reset links to sign in", async () => {
  const superToken = fakeToken();
  const server = fakeServer().on(
    "POST",
    "/api/collections/hbc_3142635823/confirm-password-reset",
    new Response(null, { status: 204 }),
  );
  const { user } = renderApp({
    path: `/auth/confirm-password-reset/${superToken}`,
    server,
    auth: "none",
  });
  await user.type(await screen.findByLabelText("New password"), "newsecret123");
  await user.type(
    screen.getByLabelText("Confirm new password"),
    "newsecret123",
  );
  await user.click(screen.getByRole("button", { name: "Set new password" }));
  const link = await screen.findByRole("link", { name: "Sign in" });
  expect(link.getAttribute("href")).toContain("/login");
});

test("email change posts token and password", async () => {
  const server = fakeServer().on(
    "POST",
    `/api/collections/${USERS}/confirm-email-change`,
    new Response(null, { status: 204 }),
  );
  const { user } = renderApp({
    path: `/auth/confirm-email-change/${token}`,
    server,
    auth: "none",
  });
  await user.type(await screen.findByLabelText("Password"), "secret12345");
  await user.click(screen.getByRole("button", { name: "Confirm new email" }));
  await screen.findByText("Your email address was changed.");
  const [call] = server.find(
    "POST",
    `/api/collections/${USERS}/confirm-email-change`,
  );
  expect(call!.body).toEqual({ token, password: "secret12345" });
});

test("a token without collectionId shows the invalid link message and sends nothing", async () => {
  const server = fakeServer();
  renderApp({
    path: "/auth/confirm-verification/not-a-token",
    server,
    auth: "none",
  });
  await screen.findByText("Invalid or expired link.");
  expect(server.requests).toHaveLength(0);
});

test("server error shows its message", async () => {
  const server = fakeServer().on(
    "POST",
    `/api/collections/${USERS}/confirm-verification`,
    { code: 400, message: "Invalid or expired token.", data: {} },
    400,
  );
  renderApp({
    path: `/auth/confirm-verification/${token}`,
    server,
    auth: "none",
  });
  await screen.findByText("Invalid or expired token.");
});

test("password reset shows validation errors next to the input", async () => {
  const server = fakeServer().on(
    "POST",
    `/api/collections/${USERS}/confirm-password-reset`,
    {
      code: 400,
      message: "Failed to authenticate.",
      data: { password: { code: "x", message: "Too short." } },
    },
    400,
  );
  const { user } = renderApp({
    path: `/auth/confirm-password-reset/${token}`,
    server,
    auth: "none",
  });
  await user.type(await screen.findByLabelText("New password"), "x");
  await user.type(screen.getByLabelText("Confirm new password"), "x");
  await user.click(screen.getByRole("button", { name: "Set new password" }));
  await screen.findByText("Too short.");
});

test("oauth2 pages call window.close", async () => {
  const close = spyOn(window, "close").mockImplementation(() => undefined);
  const success = renderApp({
    path: "/auth/oauth2-redirect-success",
    auth: "none",
  });
  await screen.findByText("Sign-in completed. You can close this window.");
  expect(close).toHaveBeenCalledTimes(1);
  success.result.unmount();
  const failure = renderApp({
    path: "/auth/oauth2-redirect-failure",
    auth: "none",
  });
  await screen.findByText("Sign-in failed. Close this window and try again.");
  expect(close).toHaveBeenCalledTimes(2);
  failure.result.unmount();
  close.mockRestore();
});
