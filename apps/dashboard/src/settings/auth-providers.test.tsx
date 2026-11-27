import { expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import type { CollectionModel } from "@heybejs/client";
import { echoPatch, serveCollections } from "../test/editor";
import { fakeServer } from "../test/fake-server";
import { collectionsFixture } from "../test/fixtures";
import { OAUTH2_PROVIDERS } from "../collections/oauth2-providers";
import { renderApp } from "../test/render";
import { PROVIDER_ICONS } from "./provider-icons";
import { ProviderLogo } from "./ProviderLogo";

const users = collectionsFixture.find((c) => c.name === "users")!;
const members = {
  ...users,
  id: "hbc_members",
  name: "members",
  oauth2: { ...(users.oauth2 as object), providers: [] },
} as CollectionModel;

async function openPage(items: CollectionModel[] = [users]) {
  const server = serveCollections(fakeServer(), items);
  echoPatch(server, users);
  const app = renderApp({ path: "/settings/auth-providers", server });
  await screen.findByRole("heading", { name: "Settings / Auth providers" });
  await screen.findByRole("switch", { name: "Enable OAuth2" });
  const patches = () =>
    server.find("PATCH", "/api/collections/:id").map((r) => r.body as any);
  return { ...app, server, patches };
}

const card = (name: string) =>
  screen.getByRole("button", { name: `Configure ${name}` }).closest("li")!;

test("lists enabled providers before the others", async () => {
  await openPage();
  const enabled = within(
    screen.getByRole("list", { name: "Enabled providers" }),
  ).getAllByRole("listitem");
  expect(enabled).toHaveLength(1);
  expect(within(enabled[0]!).getByText("Google")).toBeTruthy();
  expect(within(enabled[0]!).getByText("Enabled")).toBeTruthy();
  const others = screen.getByRole("list", { name: "Other providers" });
  expect(within(others).queryByText("Google")).toBeNull();
  expect(within(others).getByText("GitHub")).toBeTruthy();
  expect(
    screen
      .getByRole("list", { name: "Enabled providers" })
      .compareDocumentPosition(others) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("configuring a provider saves it on the collection", async () => {
  const { user, patches } = await openPage();
  await user.click(screen.getByRole("button", { name: "Configure GitHub" }));
  const dialog = within(
    screen.getByRole("dialog", { name: "GitHub provider" }),
  );
  await user.type(dialog.getByLabelText("Client ID"), "gh-id");
  await user.type(dialog.getByLabelText("Client secret"), "gh-secret");
  await user.click(dialog.getByRole("button", { name: "Create" }));
  await screen.findByText("Auth providers saved.");
  const [patch] = patches();
  expect(patch.oauth2.enabled).toBe(true);
  expect(patch.oauth2.providers.map((p: any) => p.name)).toEqual([
    "google",
    "github",
  ]);
  expect(patch.oauth2.providers[1]).toMatchObject({
    clientId: "gh-id",
    clientSecret: "gh-secret",
  });
});

test("editing an enabled provider replaces it in place", async () => {
  const { user, patches } = await openPage();
  await user.click(screen.getByRole("button", { name: "Configure Google" }));
  const dialog = within(
    screen.getByRole("dialog", { name: "Google provider" }),
  );
  await user.clear(dialog.getByLabelText("Client ID"));
  await user.type(dialog.getByLabelText("Client ID"), "new-id");
  await user.click(dialog.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Auth providers saved.");
  expect(patches()[0].oauth2.providers).toHaveLength(1);
  expect(patches()[0].oauth2.providers[0].clientId).toBe("new-id");
});

test("disable removes the provider after confirm", async () => {
  const { user, patches } = await openPage();
  await user.click(screen.getByRole("button", { name: "Disable Google" }));
  expect(patches()).toHaveLength(0);
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Disable" }),
  );
  await screen.findByText("Auth providers saved.");
  expect(patches()[0].oauth2.providers).toEqual([]);
});

test("the Enable OAuth2 switch saves", async () => {
  const { user, patches } = await openPage();
  await user.click(screen.getByRole("switch", { name: "Enable OAuth2" }));
  await screen.findByText("Auth providers saved.");
  expect(patches()[0].oauth2.enabled).toBe(false);
  expect(patches()[0].oauth2.providers).toHaveLength(1);
});

test("the picker switches collection and is hidden for a single one", async () => {
  const { user, patches } = await openPage([users, members]);
  await user.selectOptions(screen.getByLabelText("Collection"), "members");
  expect(screen.queryByRole("list", { name: "Enabled providers" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Configure GitHub" }));
  const dialog = within(
    screen.getByRole("dialog", { name: "GitHub provider" }),
  );
  await user.type(dialog.getByLabelText("Client ID"), "x");
  await user.type(dialog.getByLabelText("Client secret"), "y");
  await user.click(dialog.getByRole("button", { name: "Create" }));
  await screen.findByText("Auth providers saved.");
  expect(patches()[0].oauth2.providers.map((p: any) => p.name)).toEqual([
    "github",
  ]);
});

test("no picker with a single auth collection", async () => {
  await openPage();
  expect(screen.queryByLabelText("Collection")).toBeNull();
});

test("every known provider has a logo", () => {
  const missing = OAUTH2_PROVIDERS.filter((p) => !PROVIDER_ICONS[p.name]);
  expect(missing.map((p) => p.name)).toEqual([]);
});

test("shows a monogram only for a provider without an icon", () => {
  render(<ProviderLogo name="unknown" displayName="Acme" />);
  expect(screen.getByTestId("monogram").textContent).toBe("A");
});

test("renders a multi-color logo as drawn", async () => {
  await openPage();
  const paths = card("Microsoft").querySelectorAll(
    "span[aria-hidden] svg path",
  );
  expect([...paths].map((p) => p.getAttribute("fill"))).toEqual([
    "#F1511B",
    "#80CC28",
    "#00ADEF",
    "#FBBC09",
  ]);
  expect(within(card("Microsoft")).queryByTestId("monogram")).toBeNull();
});

test("shows an empty state without auth collections", async () => {
  const server = serveCollections(fakeServer(), [
    collectionsFixture.find((c) => c.name === "_superusers")!,
  ]);
  renderApp({ path: "/settings/auth-providers", server });
  await screen.findByText("No auth collections");
});
