import { expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import { fakeServer, type FakeServer } from "../test/fake-server";
import { settingsFixture } from "../test/fixtures";
import { renderApp } from "../test/render";

function serve(server = fakeServer()): FakeServer {
  return server.on("PATCH", "/api/settings", (req) => {
    const { secret: _, ...s3 } = (req.body as any).s3 ?? {};
    return { ...settingsFixture, ...(req.body as object), s3 };
  });
}

async function openStorage(server = serve()) {
  const app = renderApp({ path: "/settings/storage", server });
  await screen.findByLabelText("Endpoint");
  const save = () =>
    app.user.click(screen.getByRole("button", { name: "Save changes" }));
  const sent = () =>
    server.find("PATCH", "/api/settings").map((r) => r.body as any);
  return { ...app, server, save, sent };
}

const testButton = () =>
  screen.getByRole("button", { name: "Test connection" }) as HTMLButtonElement;

test("shows the note about existing files", async () => {
  await openStorage();
  expect(
    screen.getByText("Existing files are not moved when you switch storage."),
  ).toBeTruthy();
});

test("s3 secret is sent only when typed", async () => {
  const { user, save, sent } = await openStorage();
  await user.type(screen.getByLabelText("Bucket"), "b");
  await save();
  await screen.findByText("Settings saved.");
  expect("secret" in sent()[0].s3).toBe(false);

  await user.type(screen.getByLabelText("Secret"), "abc");
  await user.clear(screen.getByLabelText("Secret"));
  await user.type(screen.getByLabelText("Bucket"), "c");
  await save();
  await screen.findAllByText("Settings saved.");
  expect("secret" in sent()[1].s3).toBe(false);

  await user.type(screen.getByLabelText("Secret"), "s3cret");
  await save();
  await screen.findAllByText("Settings saved.");
  expect(sent()[2].s3.secret).toBe("s3cret");
  expect(sent()[2].backups).toBeUndefined();
});

test("storage test is disabled while dirty and calls testS3 when clean", async () => {
  const server = serve(fakeServer()).on(
    "POST",
    "/api/settings/test/s3",
    () => undefined,
  );
  const { user } = await openStorage(server);
  expect(testButton().disabled).toBe(false);
  await user.type(screen.getByLabelText("Secret"), "x");
  expect(testButton().disabled).toBe(true);
  await user.clear(screen.getByLabelText("Secret"));
  await user.type(screen.getByLabelText("Bucket"), "b");
  expect(testButton().disabled).toBe(true);
  await user.click(screen.getByRole("button", { name: "Reset" }));
  await user.click(testButton());
  await screen.findByText("Connection works.");
  expect(server.find("POST", "/api/settings/test/s3")[0]!.body).toEqual({
    filesystem: "storage",
  });
});

test("test S3 failure shows the server message", async () => {
  const server = serve(fakeServer()).on(
    "POST",
    "/api/settings/test/s3",
    { status: 400, message: "Bucket not found.", data: {} },
    400,
  );
  const { user } = await openStorage(server);
  await user.click(testButton());
  expect(await screen.findByText("Bucket not found.")).toBeTruthy();
});
