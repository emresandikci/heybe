import { expect } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import type { UserEvent } from "@testing-library/user-event";
import type { CollectionModel } from "@heybejs/client";
import { fakeServer, type FakeServer } from "./fake-server";
import { collectionsFixture } from "./fixtures";
import { renderApp } from "./render";

export function serveCollections(
  server: FakeServer,
  items: CollectionModel[],
): FakeServer {
  return server.on("GET", "/api/collections", () => ({
    page: 1,
    perPage: 1000,
    totalItems: items.length,
    totalPages: 1,
    items,
  }));
}

export async function openEditor(name: string, server = fakeServer()) {
  const id = collectionsFixture.find((c) => c.name === name)?.id ?? name;
  const app = renderApp({ path: `/collections/${id}`, server });
  await app.user.click(
    await screen.findByRole("button", { name: `Edit collection ${name}` }),
  );
  const dialog = screen.getByRole("dialog", { name: `Edit ${name}` });
  const save = () =>
    app.user.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
  return { ...app, dialog, save };
}

export const fieldGroup = (name: string) => screen.getByRole("group", { name });

export function patchedFields(server: FakeServer) {
  const [patch] = server.find("PATCH", "/api/collections/:id");
  return (patch!.body as { fields: Record<string, unknown>[] }).fields;
}

export function echoPatch(server: FakeServer, base: CollectionModel) {
  return server.on("PATCH", "/api/collections/:id", (req) => ({
    ...base,
    ...(req.body as object),
  }));
}

function codeView(el: HTMLElement) {
  return el.classList.contains("cm-content")
    ? EditorView.findFromDOM(el)
    : null;
}

export function setCode(el: HTMLElement, text: string) {
  const view = codeView(el)!;
  act(() =>
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    }),
  );
}

export function codeValue(el: HTMLElement) {
  return codeView(el)!.state.doc.toString();
}

// Pastes at the end of the input: long values typed key by key re-render the whole editor per key.
export async function paste(user: UserEvent, el: HTMLElement, text: string) {
  const view = codeView(el);
  if (view) {
    const end = view.state.doc.length;
    act(() => view.dispatch({ changes: { from: end, insert: text } }));
    return;
  }
  el.focus();
  const input = el as HTMLInputElement;
  try {
    input.setSelectionRange(input.value.length, input.value.length);
  } catch {
    // number inputs have no selection
  }
  await user.paste(text);
}

export async function completionLabels(el: HTMLElement, text: string) {
  const view = EditorView.findFromDOM(el)!;
  act(() => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: text.length },
    });
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: " ",
        code: "Space",
        ctrlKey: true,
        bubbles: true,
      }),
    );
  });
  await waitFor(() =>
    expect(view.dom.querySelector(".cm-tooltip-autocomplete li")).toBeTruthy(),
  );
  return [...view.dom.querySelectorAll(".cm-tooltip-autocomplete li")].map(
    (li) =>
      [".cm-completionLabel", ".cm-completionDetail"]
        .map((sel) => li.querySelector(sel)?.textContent ?? "")
        .join(" ")
        .trim(),
  );
}
