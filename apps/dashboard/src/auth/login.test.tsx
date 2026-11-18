import { expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import { fakeServer } from "../test/fake-server";
import { SUPERUSER, fakeToken, renderApp } from "../test/render";

const base = "/api/collections/_superusers";
const authReply = { token: fakeToken(), record: SUPERUSER };

const methods = (password: boolean, otp: boolean, mfa = false) => ({
  password: { enabled: password, identityFields: ["email"] },
  oauth2: { enabled: false, providers: [] },
  mfa: { enabled: mfa, duration: 1800 },
  otp: { enabled: otp, duration: 180 },
});

test("password sign-in stores the superuser session and opens the redirect path", async () => {
  const server = fakeServer().on(
    "POST",
    `${base}/auth-with-password`,
    authReply,
  );
  const { router, client, user } = renderApp({
    path: "/login?redirect=/settings/mail",
    server,
    auth: "none",
  });
  await user.type(await screen.findByLabelText("Email"), "admin@example.com");
  await user.type(screen.getByLabelText("Password"), "secret123");
  await user.click(screen.getByRole("button", { name: "Sign in" }));

  await screen.findByRole("button", { name: "admin@example.com" });
  expect(router.state.location.pathname).toBe("/settings/mail");
  expect(client.authStore.token).toBe(authReply.token);
  expect(server.find("POST", `${base}/auth-with-password`)[0]!.body).toEqual({
    identity: "admin@example.com",
    password: "secret123",
  });
});

test("an external redirect value falls back to /collections", async () => {
  const server = fakeServer().on(
    "POST",
    `${base}/auth-with-password`,
    authReply,
  );
  const { router, user } = renderApp({
    path: "/login?redirect=https://evil.test",
    server,
    auth: "none",
  });
  await user.type(await screen.findByLabelText("Email"), "admin@example.com");
  await user.type(screen.getByLabelText("Password"), "secret123");
  await user.click(screen.getByRole("button", { name: "Sign in" }));

  await screen.findByRole("button", { name: "admin@example.com" });
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/collections/hbc_posts"),
  );
});

test("wrong password shows the server message and keeps the email", async () => {
  const server = fakeServer().on(
    "POST",
    `${base}/auth-with-password`,
    { code: 400, message: "Failed to authenticate.", data: {} },
    400,
  );
  const { router, client, user } = renderApp({
    path: "/login",
    server,
    auth: "none",
  });
  await user.type(await screen.findByLabelText("Email"), "admin@example.com");
  await user.type(screen.getByLabelText("Password"), "wrong");
  await user.click(screen.getByRole("button", { name: "Sign in" }));

  expect(
    (await screen.findByRole("alert")).textContent?.includes(
      "Failed to authenticate.",
    ),
  ).toBe(true);
  expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe(
    "admin@example.com",
  );
  expect(router.state.location.pathname).toBe("/login");
  expect(client.authStore.token).toBe("");
});

test("MFA requests an OTP for the email and finishes with mfaId", async () => {
  const server = fakeServer()
    .on("GET", `${base}/auth-methods`, methods(true, true, true))
    .on(
      "POST",
      `${base}/auth-with-password`,
      {
        code: 401,
        message: "Please complete the MFA.",
        data: {},
        mfaId: "mfa1",
      },
      401,
    )
    .on("POST", `${base}/request-otp`, { otpId: "otp1" })
    .on("POST", `${base}/auth-with-otp`, authReply);
  const { router, client, user } = renderApp({
    path: "/login",
    server,
    auth: "none",
  });
  await user.type(await screen.findByLabelText("Email"), "admin@example.com");
  await user.type(screen.getByLabelText("Password"), "secret123");
  await user.click(screen.getByRole("button", { name: "Sign in" }));

  await user.type(await screen.findByLabelText("One-time password"), "123456");
  expect(server.find("POST", `${base}/request-otp`)[0]!.body).toEqual({
    email: "admin@example.com",
  });
  await user.click(screen.getByRole("button", { name: "Verify" }));

  await screen.findByRole("button", { name: "admin@example.com" });
  expect(server.find("POST", `${base}/auth-with-otp`)[0]!.body).toEqual({
    otpId: "otp1",
    password: "123456",
    mfaId: "mfa1",
  });
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/collections/hbc_posts"),
  );
  expect(client.authStore.token).toBe(authReply.token);
});

test("OTP-only methods show the send code form and no password input", async () => {
  const server = fakeServer()
    .on("GET", `${base}/auth-methods`, methods(false, true))
    .on("POST", `${base}/request-otp`, { otpId: "otp1" })
    .on("POST", `${base}/auth-with-otp`, authReply);
  const { router, user } = renderApp({ path: "/login", server, auth: "none" });
  await user.type(await screen.findByLabelText("Email"), "admin@example.com");
  expect(screen.queryByLabelText("Password")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Send code" }));
  await user.type(await screen.findByLabelText("One-time password"), "123456");
  await user.click(screen.getByRole("button", { name: "Verify" }));

  await screen.findByRole("button", { name: "admin@example.com" });
  expect(server.find("POST", `${base}/auth-with-otp`)[0]!.body).toEqual({
    otpId: "otp1",
    password: "123456",
  });
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/collections/hbc_posts"),
  );
});

test("a rate-limited new code request keeps the previous OTP", async () => {
  const server = fakeServer()
    .on("GET", `${base}/auth-methods`, methods(false, true))
    .on("POST", `${base}/request-otp`, { otpId: "otp1" })
    .on("POST", `${base}/auth-with-otp`, authReply);
  const { user } = renderApp({ path: "/login", server, auth: "none" });
  await user.type(await screen.findByLabelText("Email"), "admin@example.com");
  await user.click(screen.getByRole("button", { name: "Send code" }));
  await user.click(
    await screen.findByRole("button", { name: "Send a new code" }),
  );
  server.on(
    "POST",
    `${base}/request-otp`,
    { code: 429, message: "Too Many Requests.", data: {} },
    429,
  );
  await user.click(screen.getByRole("button", { name: "Send code" }));

  expect(
    (await screen.findByRole("alert")).textContent?.includes(
      "Too Many Requests.",
    ),
  ).toBe(true);
  await user.type(screen.getByLabelText("One-time password"), "123456");
  await user.click(screen.getByRole("button", { name: "Verify" }));
  await screen.findByRole("button", { name: "admin@example.com" });
  expect(server.find("POST", `${base}/auth-with-otp`)[0]!.body).toEqual({
    otpId: "otp1",
    password: "123456",
  });
});

test("each sign-in step focuses its first input", async () => {
  const server = fakeServer()
    .on("GET", `${base}/auth-methods`, methods(false, true))
    .on("POST", `${base}/request-otp`, { otpId: "otp1" });
  const { user } = renderApp({ path: "/login", server, auth: "none" });
  const email = await screen.findByLabelText("Email");
  expect(document.activeElement).toBe(email);
  await user.type(email, "admin@example.com");
  await user.click(screen.getByRole("button", { name: "Send code" }));
  expect(document.activeElement).toBe(
    await screen.findByLabelText("One-time password"),
  );
});

test("a signed-in superuser opening /login lands on /collections", async () => {
  const { router } = renderApp({ path: "/login" });
  await screen.findByRole("button", { name: "admin@example.com" });
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/collections/hbc_posts"),
  );
});

for (const status of [204, 400]) {
  test(`request password reset shows the same confirmation on ${status === 204 ? "success" : "error"}`, async () => {
    const server = fakeServer().on(
      "POST",
      `${base}/request-password-reset`,
      status === 204
        ? () => undefined
        : { code: 400, message: "Something went wrong.", data: {} },
      status,
    );
    const { user } = renderApp({ path: "/login", server, auth: "none" });
    await user.click(
      await screen.findByRole("link", { name: "Forgot password?" }),
    );
    await user.type(await screen.findByLabelText("Email"), "admin@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(
      await screen.findByText("If the email exists, a reset link was sent."),
    ).toBeTruthy();
    expect(
      server.find("POST", `${base}/request-password-reset`)[0]!.body,
    ).toEqual({ email: "admin@example.com" });
  });
}
