import { expect, spyOn, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import { fakeServer } from "../test/fake-server";
import { SUPERUSER, fakeToken, renderApp } from "../test/render";

const installerToken = fakeToken({ id: "installer" });

test("installer creates the first superuser with the installer token and signs in", async () => {
  const server = fakeServer()
    .on("POST", "/api/collections/_superusers/records", SUPERUSER)
    .on("POST", "/api/collections/_superusers/auth-with-password", {
      token: fakeToken(),
      record: SUPERUSER,
    });
  const { router, client, user } = renderApp({
    path: `/hbinstall/${installerToken}`,
    server,
    auth: "none",
  });
  await user.type(await screen.findByLabelText("Email"), "admin@example.com");
  await user.type(screen.getByLabelText("Password"), "secret12345");
  await user.type(screen.getByLabelText("Confirm password"), "secret12345");
  await user.click(screen.getByRole("button", { name: "Create superuser" }));

  await screen.findByRole("button", { name: "admin@example.com" });
  const [create] = server.find("POST", "/api/collections/_superusers/records");
  expect(create!.headers.get("authorization")).toBe(installerToken);
  expect(create!.body).toEqual({
    email: "admin@example.com",
    password: "secret12345",
    passwordConfirm: "secret12345",
  });
  const [login] = server.find(
    "POST",
    "/api/collections/_superusers/auth-with-password",
  );
  expect(login!.headers.get("authorization")).toBeNull();
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/collections/hbc_posts"),
  );
  expect(client.authStore.token).toBe(fakeToken());
});

test("installer shows create validation errors next to the inputs", async () => {
  const server = fakeServer().on(
    "POST",
    "/api/collections/_superusers/records",
    {
      code: 400,
      message: "Failed to create record.",
      data: { password: { code: "x", message: "Too short." } },
    },
    400,
  );
  const { user } = renderApp({
    path: `/hbinstall/${installerToken}`,
    server,
    auth: "none",
  });
  await user.type(await screen.findByLabelText("Email"), "admin@example.com");
  await user.type(screen.getByLabelText("Password"), "x");
  await user.type(screen.getByLabelText("Confirm password"), "x");
  await user.click(screen.getByRole("button", { name: "Create superuser" }));

  expect(await screen.findByText("Too short.")).toBeTruthy();
  expect(screen.getByLabelText("Password").getAttribute("aria-invalid")).toBe(
    "true",
  );
});

test("an expired installer token shows the expiry message and no form", async () => {
  renderApp({ path: `/hbinstall/${fakeToken({ exp: 1 })}`, auth: "none" });
  expect(
    await screen.findByText(
      "This installer link has expired. Restart the server to print a new one.",
    ),
  ).toBeTruthy();
  expect(screen.queryByLabelText("Email")).toBeNull();
  expect(screen.queryByLabelText("Backup file")).toBeNull();
});

test("expired installer link shows its own title and a sign in link", async () => {
  renderApp({ path: `/hbinstall/${fakeToken({ exp: 1 })}`, auth: "none" });
  expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe(
    "Installer link expired",
  );
  expect(
    screen.getByRole("link", { name: "Sign in" }).getAttribute("href"),
  ).toContain("/login");
});

test("installer restore uploads then restores with the installer token", async () => {
  const server = fakeServer()
    .on("POST", "/api/backups/upload", () => undefined)
    .on("POST", "/api/backups/:key/restore", () => undefined);
  const { router, user } = renderApp({
    path: `/hbinstall/${installerToken}`,
    server,
    auth: "none",
  });
  const file = new File(["zip"], "hb backup.zip", {
    type: "application/zip",
  });
  await user.upload(await screen.findByLabelText("Backup file"), file);
  await user.click(screen.getByRole("button", { name: "Upload and restore" }));

  expect(
    await screen.findByText(
      "Restore started. The server restarts with the restored data; reload this page in a few seconds.",
    ),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  const [upload] = server.find("POST", "/api/backups/upload");
  expect(upload!.headers.get("authorization")).toBe(installerToken);
  expect((upload!.form!.get("file") as File).name).toBe("hb backup.zip");
  const restores = server.requests.filter((r) => r.path.endsWith("/restore"));
  expect(restores.map((r) => r.path)).toEqual([
    "/api/backups/hb%20backup.zip/restore",
  ]);
  expect(restores[0]!.headers.get("authorization")).toBe(installerToken);
  expect(server.requests.indexOf(upload!)).toBeLessThan(
    server.requests.indexOf(restores[0]!),
  );

  const reload = spyOn(location, "reload").mockImplementation(() => {});
  await user.click(screen.getByRole("button", { name: "Reload" }));
  expect(router.state.location.pathname).toBe("/login");
  expect(reload).toHaveBeenCalledTimes(1);
  reload.mockRestore();
});
