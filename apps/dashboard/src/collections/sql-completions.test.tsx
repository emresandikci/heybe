import { expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { openEditor } from "../test/editor";

async function offered(user: UserEvent, input: HTMLElement) {
  input.focus();
  await user.keyboard("{Control>} {/Control}");
  await waitFor(() =>
    expect(document.querySelector(".cm-tooltip-autocomplete")).toBeTruthy(),
  );
  return [...document.querySelectorAll(".cm-completionLabel")].map(
    (el) => el.textContent,
  );
}

test("the view query field offers collection names and collection.field entries", async () => {
  const { user, dialog } = await openEditor("stats");
  const labels = await offered(
    user,
    within(dialog).getByLabelText("Select query"),
  );
  expect(labels).toContain("posts");
  expect(labels).toContain("posts.title");
  expect(labels).toContain("GROUP BY");
});

test("the index SQL field offers the collection's field names", async () => {
  const { user } = await openEditor("posts");
  await user.click(screen.getByRole("button", { name: "Add index" }));
  const dialog = screen.getByRole("dialog", { name: "Add index" });
  const labels = await offered(
    user,
    within(dialog).getByLabelText("Index SQL"),
  );
  expect(labels).toContain("LOWER");
  expect(labels).toContain("COLLATE NOCASE");
});
