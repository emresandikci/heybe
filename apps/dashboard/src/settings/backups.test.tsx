import { afterEach, expect, spyOn, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { fakeServer, type FakeServer } from "../test/fake-server";
import { settingsFixture } from "../test/fixtures";
import { renderApp } from "../test/render";
import { formatBytes } from "./format";

const backup = {
  key: "a.zip",
  size: 1536,
  modified: "2026-11-11 10:00:00.000Z",
};

function serve(opts: { canBackup?: boolean; backups?: object[] } = {}) {
  const list = opts.backups ?? [backup];
  return fakeServer()
    .on("GET", "/api/backups", () => list)
    .on("GET", "/api/health", () => ({
      code: 200,
      message: "",
      data: { canBackup: opts.canBackup ?? true },
    }))
    .on("PATCH", "/api/settings", (req) => {
      const body = req.body as any;
      const { secret: _, ...s3 } = body.backups?.s3 ?? {};
      return {
        ...settingsFixture,
        ...body,
        backups: { ...body.backups, s3 },
      };
    });
}

async function openBackups(server: FakeServer = serve()) {
  const app = renderApp({ path: "/settings/backups", server });
  await screen.findByText("a.zip");
  const row = () => within(screen.getByRole("row", { name: /a\.zip/ }));
  return { ...app, server, row };
}

afterEach(() => {
  spyOn(window, "open").mockRestore();
});

test("formatBytes", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
});

test("lists backups with size", async () => {
  const { row } = await openBackups();
  expect(row().getByText("1.5 KB")).toBeTruthy();
});

test("create posts the typed name, or no name key when empty", async () => {
  const server = serve().on("POST", "/api/backups", () => undefined);
  const { user } = await openBackups(server);
  await user.click(screen.getByRole("button", { name: "Create backup" }));
  let dialog = within(screen.getByRole("dialog", { name: "Create backup" }));
  await user.click(dialog.getByRole("button", { name: "Create" }));
  await screen.findByText("Backup created.");
  expect(server.find("POST", "/api/backups")[0]!.body).toEqual({});

  await user.click(screen.getByRole("button", { name: "Create backup" }));
  dialog = within(screen.getByRole("dialog", { name: "Create backup" }));
  await user.type(dialog.getByLabelText("Name"), "mine.zip");
  await user.click(dialog.getByRole("button", { name: "Create" }));
  await screen.findAllByText("Backup created.");
  expect(server.find("POST", "/api/backups")[1]!.body).toEqual({
    name: "mine.zip",
  });
});

test("create failure shows the server message", async () => {
  const server = serve().on(
    "POST",
    "/api/backups",
    { status: 400, message: "Invalid name.", data: {} },
    400,
  );
  const { user } = await openBackups(server);
  await user.click(screen.getByRole("button", { name: "Create backup" }));
  const dialog = within(screen.getByRole("dialog", { name: "Create backup" }));
  await user.click(dialog.getByRole("button", { name: "Create" }));
  expect(await dialog.findByText("Invalid name.")).toBeTruthy();
});

test("upload posts the zip as multipart file", async () => {
  const server = serve().on("POST", "/api/backups/upload", () => undefined);
  const { user } = await openBackups(server);
  const file = new File(["zipdata"], "up.zip", { type: "application/zip" });
  await user.upload(screen.getByLabelText("Backup file"), file);
  await screen.findByText("Backup uploaded.");
  const form = server.find("POST", "/api/backups/upload")[0]!.form!;
  expect((form.get("file") as File).name).toBe("up.zip");
});

test("restore requires typing the key, posts restore and shows the restart notice", async () => {
  const server = serve().on(
    "POST",
    "/api/backups/:key/restore",
    () => undefined,
  );
  const { user, row } = await openBackups(server);
  await user.click(row().getByRole("button", { name: "Restore" }));
  const dialog = within(screen.getByRole("dialog"));
  const confirm = dialog.getByRole("button", {
    name: "Restore",
  }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  expect(server.find("POST", "/api/backups/:key/restore")).toHaveLength(0);
  await user.type(dialog.getByLabelText('Type "a.zip" to confirm'), "a.zip");
  await user.click(confirm);
  expect(
    await screen.findByText(
      "Restore started. The server restarts with the restored data.",
    ),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  expect(server.find("POST", "/api/backups/:key/restore")).toHaveLength(1);
});

test("restore still shows the notice when the connection drops", async () => {
  const server = serve().on("POST", "/api/backups/:key/restore", () => {
    throw new TypeError("fetch failed");
  });
  const { user, row } = await openBackups(server);
  await user.click(row().getByRole("button", { name: "Restore" }));
  const dialog = within(screen.getByRole("dialog"));
  await user.type(dialog.getByLabelText('Type "a.zip" to confirm'), "a.zip");
  await user.click(dialog.getByRole("button", { name: "Restore" }));
  expect(await screen.findByText(/Restore started\./)).toBeTruthy();
});

test("restore failure from the server shows the message", async () => {
  const server = serve().on(
    "POST",
    "/api/backups/:key/restore",
    { status: 400, message: "Broken archive.", data: {} },
    400,
  );
  const { user, row } = await openBackups(server);
  await user.click(row().getByRole("button", { name: "Restore" }));
  const dialog = within(screen.getByRole("dialog"));
  await user.type(dialog.getByLabelText('Type "a.zip" to confirm'), "a.zip");
  await user.click(dialog.getByRole("button", { name: "Restore" }));
  expect(await screen.findByText("Broken archive.")).toBeTruthy();
  expect(screen.queryByText(/Restore started\./)).toBeNull();
});

test("delete confirms then deletes", async () => {
  const server = serve().on("DELETE", "/api/backups/:key", () => undefined);
  const { user, row } = await openBackups(server);
  await user.click(row().getByRole("button", { name: "Delete" }));
  expect(server.find("DELETE", "/api/backups/:key")).toHaveLength(0);
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }),
  );
  await screen.findByText("Backup deleted.");
  expect(server.find("DELETE", "/api/backups/:key")[0]!.path).toBe(
    "/api/backups/a.zip",
  );
});

test("download follows downloadURL with a fresh file token", async () => {
  const click = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    () => {},
  );
  const server = serve().on("POST", "/api/files/token", { token: "ft1" });
  const { user, row } = await openBackups(server);
  await user.click(row().getByRole("button", { name: "Download" }));
  await screen.findByRole("table");
  await Promise.resolve();
  expect(click).toHaveBeenCalledTimes(1);
  const link = click.mock.contexts[0] as HTMLAnchorElement;
  expect(link.href).toContain("/api/backups/a.zip?token=ft1");
  expect(link.download).toBe("a.zip");
  click.mockRestore();
});

test("canBackup false disables create and restore", async () => {
  const { row } = await openBackups(serve({ canBackup: false }));
  await screen.findByText("A backup or restore is already running.");
  expect(
    (screen.getByRole("button", { name: "Create backup" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (row().getByRole("button", { name: "Restore" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("automatic backup cron and maxKeep are PATCHed under backups", async () => {
  const { user, server } = await openBackups();
  await user.selectOptions(
    await screen.findByRole("combobox", { name: "Schedule" }),
    "0 0 * * *",
  );
  const keep = screen.getByLabelText("Keep the last");
  await user.clear(keep);
  await user.type(keep, "5");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Settings saved.");
  expect(server.find("PATCH", "/api/settings")[0]!.body).toEqual({
    backups: { ...settingsFixture.backups, cron: "0 0 * * *", cronMaxKeep: 5 },
  });
});

test("custom schedule shows a text input", async () => {
  const { user, server } = await openBackups();
  await user.selectOptions(
    await screen.findByRole("combobox", { name: "Schedule" }),
    "custom",
  );
  await user.type(
    screen.getByLabelText("Custom cron expression"),
    "*/5 * * * *",
  );
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Settings saved.");
  expect(
    (server.find("PATCH", "/api/settings")[0]!.body as any).backups.cron,
  ).toBe("*/5 * * * *");
});

test("backups s3 secret is sent only when typed", async () => {
  const { user, server } = await openBackups();
  const save = () =>
    user.click(screen.getByRole("button", { name: "Save changes" }));
  const sent = () =>
    server.find("PATCH", "/api/settings").map((r) => r.body as any);
  await user.click(await screen.findByRole("button", { name: /S3 storage/ }));
  await user.click(screen.getByRole("switch", { name: "Use S3 storage" }));
  await user.type(screen.getByLabelText("Bucket"), "b");
  await save();
  await screen.findByText("Settings saved.");
  expect("secret" in sent()[0].backups.s3).toBe(false);

  await user.type(screen.getByLabelText("Secret"), "abc");
  await user.clear(screen.getByLabelText("Secret"));
  await user.type(screen.getByLabelText("Bucket"), "c");
  await save();
  await screen.findAllByText("Settings saved.");
  expect("secret" in sent()[1].backups.s3).toBe(false);

  await user.type(screen.getByLabelText("Secret"), "s3cret");
  await save();
  await screen.findAllByText("Settings saved.");
  expect(sent()[2].backups.s3.secret).toBe("s3cret");
  expect(sent()[2].s3).toBeUndefined();
});

test("backups test connection is disabled while dirty and calls testS3('backups')", async () => {
  const server = serve().on("POST", "/api/settings/test/s3", () => undefined);
  const { user } = await openBackups(server);
  const test = () =>
    screen.getByRole("button", {
      name: "Test connection",
    }) as HTMLButtonElement;
  await user.click(await screen.findByRole("button", { name: /S3 storage/ }));
  await user.click(screen.getByRole("switch", { name: "Use S3 storage" }));
  await user.type(screen.getByLabelText("Bucket"), "b");
  expect(test().disabled).toBe(true);
  await user.click(screen.getByRole("button", { name: "Reset" }));
  await user.click(test());
  await screen.findByText("Connection works.");
  expect(server.find("POST", "/api/settings/test/s3")[0]!.body).toEqual({
    filesystem: "backups",
  });
});

test("reset brings back a stored custom schedule after picking a preset", async () => {
  const server = serve().on("GET", "/api/settings", {
    ...settingsFixture,
    backups: { ...settingsFixture.backups, cron: "0 5 * * *" },
  });
  const { user } = await openBackups(server);
  const schedule = await screen.findByRole("combobox", { name: "Schedule" });
  expect((schedule as HTMLSelectElement).value).toBe("custom");
  await user.selectOptions(schedule, "");
  expect(screen.queryByLabelText("Custom cron expression")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Reset" }));
  expect((schedule as HTMLSelectElement).value).toBe("custom");
  expect(
    (screen.getByLabelText("Custom cron expression") as HTMLInputElement).value,
  ).toBe("0 5 * * *");
});
