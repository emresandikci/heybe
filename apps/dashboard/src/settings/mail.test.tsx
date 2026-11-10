import { expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { fakeServer, type FakeServer } from "../test/fake-server";
import { settingsFixture } from "../test/fixtures";
import { renderApp } from "../test/render";

function echoSettings(server: FakeServer) {
  return server.on("PATCH", "/api/settings", (req) => {
    const { password: _, ...smtp } = (req.body as any).smtp ?? {};
    return { ...settingsFixture, ...(req.body as object), smtp };
  });
}

async function openMail(server = echoSettings(fakeServer())) {
  const app = renderApp({ path: "/settings/mail", server });
  await screen.findByLabelText("Host");
  const save = () =>
    app.user.click(screen.getByRole("button", { name: "Save changes" }));
  const sent = () =>
    server.find("PATCH", "/api/settings").map((r) => r.body as any);
  return { ...app, server, save, sent };
}

test("saving mail without typing a password sends no smtp.password", async () => {
  const { user, save, sent } = await openMail();
  await user.type(screen.getByLabelText("Sender name"), "x");
  await user.type(screen.getByLabelText("Host"), "x");
  await save();
  await screen.findByText("Settings saved.");
  expect(Object.keys(sent())).toEqual(["0"]);
  expect(Object.keys(sent()[0])).toEqual(["meta", "smtp"]);
  expect("password" in sent()[0].smtp).toBe(false);
});

test("typing a password sends it, clearing it again sends no key", async () => {
  const { user, save, sent } = await openMail();
  const password = screen.getByLabelText("Password");
  await user.type(password, "hunter2");
  await save();
  await screen.findByText("Settings saved.");
  expect(sent()[0]).toEqual({
    smtp: { ...settingsFixture.smtp, password: "hunter2" },
  });

  await user.type(screen.getByLabelText("Host"), "x");
  await user.type(screen.getByLabelText("Password"), "abc");
  await user.clear(screen.getByLabelText("Password"));
  await save();
  await screen.findAllByText("Settings saved.");
  expect("password" in sent()[1].smtp).toBe(false);
});

test("the password input does not autofill saved passwords", async () => {
  await openMail();
  expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe(
    "new-password",
  );
});

test("send test email is disabled while the form is dirty", async () => {
  const { user } = await openMail();
  const button = screen.getByRole("button", {
    name: "Send test email",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  await user.type(screen.getByLabelText("Host"), "x");
  expect(button.disabled).toBe(true);
});

test("test email posts template, email and collection", async () => {
  const server = echoSettings(fakeServer()).on(
    "POST",
    "/api/settings/test/email",
    () => undefined,
  );
  const { user } = await openMail(server);
  await user.click(screen.getByRole("button", { name: "Send test email" }));
  const dialog = within(
    screen.getByRole("dialog", { name: "Send test email" }),
  );
  await user.click(dialog.getByLabelText("password-reset"));
  await user.type(dialog.getByLabelText("Email"), "a@b.co");
  await user.selectOptions(dialog.getByLabelText("Auth collection"), "users");
  await user.click(dialog.getByRole("button", { name: "Send" }));
  await screen.findByText("Test email sent.");
  expect(server.find("POST", "/api/settings/test/email")[0]!.body).toEqual({
    email: "a@b.co",
    template: "password-reset",
    collection: "users",
  });
});

test("test email defaults to _superusers and verification", async () => {
  const server = echoSettings(fakeServer()).on(
    "POST",
    "/api/settings/test/email",
    () => undefined,
  );
  const { user } = await openMail(server);
  await user.click(screen.getByRole("button", { name: "Send test email" }));
  const dialog = within(
    screen.getByRole("dialog", { name: "Send test email" }),
  );
  await user.type(dialog.getByLabelText("Email"), "a@b.co");
  await user.click(dialog.getByRole("button", { name: "Send" }));
  await screen.findByText("Test email sent.");
  expect(server.find("POST", "/api/settings/test/email")[0]!.body).toEqual({
    email: "a@b.co",
    template: "verification",
    collection: "_superusers",
  });
});

test("test email failure shows the server message", async () => {
  const server = echoSettings(fakeServer()).on(
    "POST",
    "/api/settings/test/email",
    { status: 400, message: "SMTP is down.", data: {} },
    400,
  );
  const { user } = await openMail(server);
  await user.click(screen.getByRole("button", { name: "Send test email" }));
  const dialog = within(
    screen.getByRole("dialog", { name: "Send test email" }),
  );
  await user.type(dialog.getByLabelText("Email"), "a@b.co");
  await user.click(dialog.getByRole("button", { name: "Send" }));
  expect(await dialog.findByText("SMTP is down.")).toBeTruthy();
});

test("server error under the smtp host input", async () => {
  const server = fakeServer().on(
    "PATCH",
    "/api/settings",
    {
      status: 400,
      message: "Failed to save.",
      data: { smtp: { host: { code: "x", message: "Invalid host." } } },
    },
    400,
  );
  const { user, save } = await openMail(server);
  await user.type(screen.getByLabelText("Host"), "x");
  await save();
  expect(await screen.findAllByText("Invalid host.")).toHaveLength(1);
});
