import { expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import { fakeServer } from "../../test/fake-server";
import { echoPatch, openEditor, serveCollections } from "../../test/editor";
import { collectionsFixture, scaffoldsFixture } from "../../test/fixtures";
import { renderApp } from "../../test/render";
import { readSource, stripSource, withSource } from "./mjml";
import { mjmlStarter } from "./mjml-starters";

const users = collectionsFixture.find((c) => c.name === "users")!;
const group = (name: string) => within(screen.getByRole("group", { name }));
const SOURCE =
  "<mjml><mj-body><mj-section><mj-column><mj-text>Saved {APP_NAME}</mj-text></mj-column></mj-section></mj-body></mjml>";

async function openTemplates(collection = users) {
  const server = echoPatch(
    serveCollections(
      fakeServer(),
      collectionsFixture.map((c) => (c.id === collection.id ? collection : c)),
    ),
    collection,
  );
  const app = await openEditor(collection.name, server);
  await app.user.click(
    within(app.dialog).getByRole("tab", { name: "Options" }),
  );
  const saveButton = within(app.dialog).getByRole("button", {
    name: "Save changes",
  }) as HTMLButtonElement;
  const saved = async () => {
    await waitFor(() => expect(saveButton.disabled).toBe(false));
    await app.save();
    await screen.findByText("Collection saved.");
    const [patch] = server.find("PATCH", "/api/collections/:id");
    return patch!.body as Record<string, { body: string }>;
  };
  return { ...app, server, saved, saveButton };
}

const withMjml = {
  ...users,
  verificationTemplate: {
    subject: "Verify",
    body: withSource("<p>compiled</p>", SOURCE),
  },
};

async function paste(
  user: Awaited<ReturnType<typeof openTemplates>>["user"],
  area: HTMLElement,
  text: string,
) {
  await user.clear(area);
  area.focus();
  await user.paste(text);
}

test("a body with the MJML marker opens in MJML mode with its source", async () => {
  await openTemplates(withMjml);
  expect(
    (
      group("Verification email").getByLabelText(
        "Body (MJML)",
      ) as HTMLTextAreaElement
    ).value,
  ).toBe(SOURCE);
});

test("a body without the marker opens as HTML and Convert to MJML starts from the starter", async () => {
  const { user, saved } = await openTemplates();
  const reset = group("Password reset email");
  expect(
    (reset.getByLabelText("Body (HTML)") as HTMLTextAreaElement).value,
  ).toBe("<p>Reset</p>");
  await user.click(reset.getByRole("button", { name: "Convert to MJML" }));
  await user.click(
    within(screen.getByRole("dialog", { name: "Convert to MJML" })).getByRole(
      "button",
      { name: "Convert" },
    ),
  );
  const starter = mjmlStarter("resetPassword", false);
  expect(
    (reset.getByLabelText("Body (MJML)") as HTMLTextAreaElement).value,
  ).toBe(starter);
  const body = (await saved()).resetPasswordTemplate!.body;
  expect(readSource(body)).toBe(starter);
  expect(stripSource(body)).toContain(
    'href="{APP_URL}/_/#/auth/confirm-password-reset/{TOKEN}"',
  );
});

test("editing MJML saves the compiled HTML with its source", async () => {
  const { user, saved } = await openTemplates(withMjml);
  const source = SOURCE.replace("Saved {APP_NAME}", "Hello {RECORD:name}");
  await paste(
    user,
    group("Verification email").getByLabelText("Body (MJML)"),
    source,
  );
  const body = (await saved()).verificationTemplate!.body;
  expect(readSource(body)).toBe(source);
  expect(stripSource(body)).toContain("Hello {RECORD:name}");
  expect(stripSource(body)).not.toContain("<mj-");
});

test("MJML errors show next to the body and block saving", async () => {
  const { user, dialog, saveButton } = await openTemplates(withMjml);
  const verify = group("Verification email");
  const area = verify.getByLabelText("Body (MJML)");
  await paste(user, area, SOURCE.replace("<mj-text>", '<mj-text foo="1">'));
  await verify.findByText("Line 1: Attribute foo is illegal");
  expect(area.getAttribute("aria-invalid")).toBe("true");
  expect(saveButton.disabled).toBe(true);
  expect(
    within(dialog).getByText(
      "Fix the MJML errors in the email templates before saving.",
    ),
  ).toBeTruthy();
});

test("the preview shows the compiled HTML in a sandboxed iframe", async () => {
  const { user } = await openTemplates(withMjml);
  const verify = group("Verification email");
  await user.click(verify.getByRole("button", { name: "Show preview" }));
  const frame = verify.getByTitle("Verification email preview");
  expect(frame.getAttribute("sandbox")).toBe("");
  expect(frame.getAttribute("srcdoc")).toBe("<p>compiled</p>");
});

test("the test email waits until template changes are saved", async () => {
  const { user } = await openTemplates();
  const reset = group("Password reset email");
  await user.type(reset.getByLabelText("Subject"), "!");
  expect(
    (
      reset.getByRole("button", {
        name: "Send test email",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    reset.getByText("Save first: the test email uses the saved template."),
  ).toBeTruthy();
});

test("new auth collections start their templates in MJML", async () => {
  const server = fakeServer()
    .on("GET", "/api/collections/meta/scaffolds", {
      ...scaffoldsFixture,
      auth: {
        ...scaffoldsFixture.auth!,
        verificationTemplate: { subject: "Verify", body: "<p>Verify</p>" },
      },
    })
    .on("POST", "/api/collections", { ...users, id: "pbc_members" });
  const { user } = renderApp({ path: "/collections/pbc_posts", server });
  await user.click(
    await screen.findByRole("button", { name: "New collection" }),
  );
  const dialog = within(screen.getByRole("dialog", { name: "New collection" }));
  await user.type(await dialog.findByLabelText("Name"), "members");
  await user.selectOptions(dialog.getByLabelText("Type"), "auth");
  await user.click(dialog.getByRole("tab", { name: "Options" }));
  const starter = mjmlStarter("verification", false);
  expect(
    (
      group("Verification email").getByLabelText(
        "Body (MJML)",
      ) as HTMLTextAreaElement
    ).value,
  ).toBe(starter);
  const create = dialog.getByRole("button", {
    name: "Create",
  }) as HTMLButtonElement;
  await waitFor(() => expect(create.disabled).toBe(false));
  await user.click(create);
  await screen.findByText("Collection created.");
  const [post] = server.find("POST", "/api/collections");
  const body = (post!.body as { verificationTemplate: { body: string } })
    .verificationTemplate.body;
  expect(readSource(body)).toBe(starter);
});

test("_superusers templates convert to the superuser starters", async () => {
  const { user } = renderApp({ path: "/collections/pbc_3142635823" });
  await user.click(await screen.findByRole("button", { name: "System" }));
  await user.click(
    screen.getByRole("button", { name: "Edit collection _superusers" }),
  );
  const dialog = within(
    screen.getByRole("dialog", { name: "Edit _superusers" }),
  );
  await user.click(dialog.getByRole("tab", { name: "Options" }));
  const reset = group("Password reset email");
  await user.click(reset.getByRole("button", { name: "Convert to MJML" }));
  await user.click(
    within(screen.getByRole("dialog", { name: "Convert to MJML" })).getByRole(
      "button",
      { name: "Convert" },
    ),
  );
  expect(
    (reset.getByLabelText("Body (MJML)") as HTMLTextAreaElement).value,
  ).toBe(mjmlStarter("resetPassword", true));
});

test("Edit as HTML asks first and Convert to MJML restores the saved source", async () => {
  const { user } = await openTemplates(withMjml);
  const verify = group("Verification email");
  await user.click(verify.getByRole("button", { name: "Edit as HTML" }));
  const ask = () =>
    within(screen.getByRole("dialog", { name: "Edit as HTML" }));
  await user.click(ask().getByRole("button", { name: "Cancel" }));
  expect(verify.getByLabelText("Body (MJML)")).toBeTruthy();
  await user.click(verify.getByRole("button", { name: "Edit as HTML" }));
  await user.click(ask().getByRole("button", { name: "Edit as HTML" }));
  expect(
    (verify.getByLabelText("Body (HTML)") as HTMLTextAreaElement).value,
  ).toBe("<p>compiled</p>");
  await user.click(verify.getByRole("button", { name: "Convert to MJML" }));
  expect(
    screen.queryAllByRole("dialog", { name: "Convert to MJML" }).length,
  ).toBe(0);
  expect(
    (verify.getByLabelText("Body (MJML)") as HTMLTextAreaElement).value,
  ).toBe(SOURCE);
});

test("the body hint lists {OTP_ID}", async () => {
  await openTemplates();
  expect(group("OTP email").getByText(/\{OTP_ID\}/)).toBeTruthy();
});
