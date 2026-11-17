import { expect, test } from "bun:test";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { EditorView } from "@codemirror/view";
import { fakeServer } from "../../test/fake-server";
import { codeValue, echoPatch, openEditor, setCode } from "../../test/editor";
import { collectionsFixture } from "../../test/fixtures";
import { RuleInput } from "./RuleInput";

const posts = collectionsFixture.find((c) => c.name === "posts")!;
const rule = (label: string) =>
  within(screen.getByRole("group", { name: label }));

async function openRules(name: string, server = fakeServer()) {
  const app = await openEditor(name, server);
  await app.user.click(
    within(app.dialog).getByRole("tab", { name: "API rules" }),
  );
  return app;
}

const ruleLabels = () =>
  screen
    .getAllByRole("group")
    .map(
      (g) =>
        g.getAttribute("aria-label") ?? g.querySelector("legend")?.textContent,
    )
    .filter((name) => name?.endsWith(" rule"));

test('locked rule is sent as null and an unlocked empty rule as ""', async () => {
  const server = echoPatch(fakeServer(), posts);
  const { user, save } = await openRules("posts", server);
  const list = rule("List/Search rule");
  const area = list.getByLabelText("List/Search rule");
  expect(area.getAttribute("contenteditable")).toBe("false");
  await user.click(list.getByLabelText("Superusers only"));
  expect(area.getAttribute("contenteditable")).toBe("true");
  expect(codeValue(area)).toBe("");
  expect(list.getByText("Empty rule: everyone, guests included.")).toBeTruthy();
  await user.click(rule("View rule").getByLabelText("Superusers only"));
  setCode(rule("View rule").getByLabelText("View rule"), "id != ''");
  await save();
  await user.click(
    within(screen.getByRole("dialog", { name: "Confirm changes" })).getByRole(
      "button",
      { name: "Confirm" },
    ),
  );
  await screen.findByText("Collection saved.");
  const [patch] = server.find("PATCH", "/api/collections/pbc_posts");
  expect(patch!.body).toMatchObject({
    listRule: "",
    viewRule: "id != ''",
    createRule: null,
    updateRule: null,
    deleteRule: null,
  });
});

test("a chip inserts at the cursor", async () => {
  const user = userEvent.setup({ delay: null });
  function Host() {
    const [value, setValue] = useState<string | null>("a  b");
    return (
      <RuleInput
        label="List/Search rule"
        value={value}
        onChange={setValue}
        chips={["@now", "title"]}
        errorPath="listRule"
      />
    );
  }
  render(<Host />);
  const area = screen.getByLabelText("List/Search rule");
  const view = EditorView.findFromDOM(area)!;
  act(() => view.dispatch({ selection: { anchor: 2 } }));
  await user.click(screen.getByRole("button", { name: "@now" }));
  expect(codeValue(area)).toBe("a @now b");
  expect(document.activeElement).toBe(area);
  expect(view.state.selection.main.head).toBe(6);
});

test("view collections show only list and view rules", async () => {
  await openRules("stats");
  expect(ruleLabels()).toEqual(["List/Search rule", "View rule"]);
});

test("auth collections add auth and manage rules", async () => {
  await openRules("users");
  expect(ruleLabels()).toEqual([
    "List/Search rule",
    "View rule",
    "Create rule",
    "Update rule",
    "Delete rule",
    "Auth rule",
    "Manage rule",
  ]);
});

test("server rule error shows under its rule", async () => {
  const server = fakeServer().on(
    "PATCH",
    "/api/collections/:id",
    {
      code: 400,
      message: "Failed to update collection.",
      data: { listRule: { message: "Invalid rule." } },
    },
    400,
  );
  const { dialog, save } = await openEditor("posts", server);
  await save();
  await rule("List/Search rule").findByText("Invalid rule.");
  expect(
    within(dialog)
      .getByRole("tab", { name: "API rules" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(within(dialog).getByRole("alert").textContent).not.toContain(
    "listRule",
  );
});

test("lock then unlock restores the typed rule", async () => {
  const { user } = await openRules("posts");
  const list = rule("List/Search rule");
  await user.click(list.getByLabelText("Superusers only"));
  setCode(list.getByLabelText("List/Search rule"), "id != ''");
  await user.click(list.getByLabelText("Superusers only"));
  expect(codeValue(list.getByLabelText("List/Search rule"))).toBe("");
  await user.click(list.getByLabelText("Superusers only"));
  expect(codeValue(list.getByLabelText("List/Search rule"))).toBe("id != ''");
});

test("auth and manage rules explain their own empty value", async () => {
  const { user } = await openRules("users");
  const manage = rule("Manage rule");
  await user.click(manage.getByLabelText("Superusers only"));
  expect(
    manage.getByText("A manage rule cannot be empty. Write a rule or lock it."),
  ).toBeTruthy();
  expect(
    manage.queryByText("Empty rule: everyone, guests included."),
  ).toBeNull();
  expect(
    rule("Auth rule").getByText(
      "Empty rule: any account with valid credentials can sign in.",
    ),
  ).toBeTruthy();
});
