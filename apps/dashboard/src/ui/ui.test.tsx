import { describe, expect, setSystemTime, test } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";
import {
  acceptCompletion,
  currentCompletions,
  startCompletion,
} from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Dialog } from "./Dialog";
import { ConfirmProvider, useConfirm } from "./Confirm";
import { TextField } from "./TextField";
import { Tabs } from "./Tabs";
import { CodeArea } from "./CodeArea";

describe("ui", () => {
  test("Dialog opens with showModal, Esc closes and focus returns to the opener", async () => {
    const user = userEvent.setup({ delay: null });
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <Dialog open={open} onClose={() => setOpen(false)} title="Hello">
            <button>Inside</button>
          </Dialog>
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Hello" });
    expect((dialog as HTMLDialogElement).open).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test("useConfirm with typeToConfirm keeps Confirm disabled until the text matches", async () => {
    const user = userEvent.setup({ delay: null });
    let result: boolean | undefined;
    function Host() {
      const confirm = useConfirm();
      return (
        <button
          onClick={async () => {
            result = await confirm({
              title: "Delete posts",
              message: "This cannot be undone.",
              confirmLabel: "Delete",
              danger: true,
              typeToConfirm: "posts",
            });
          }}
        >
          Ask
        </button>
      );
    }
    render(
      <ConfirmProvider>
        <Host />
      </ConfirmProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Ask" }));
    const confirmButton = screen.getByRole("button", {
      name: "Delete",
    }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    await user.type(screen.getByLabelText(/Type "posts"/), "posts");
    expect(confirmButton.disabled).toBe(false);
    await user.click(confirmButton);
    expect(result).toBe(true);
  });

  test("useConfirm resolves false on cancel", async () => {
    const user = userEvent.setup({ delay: null });
    let result: boolean | undefined;
    function Host() {
      const confirm = useConfirm();
      return (
        <button
          onClick={async () => {
            result = await confirm({
              title: "Sure",
              message: "Really?",
              confirmLabel: "Yes",
            });
          }}
        >
          Ask
        </button>
      );
    }
    render(
      <ConfirmProvider>
        <Host />
      </ConfirmProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(result).toBe(false);
  });

  test("TextField links its label, error and aria-invalid", () => {
    render(<TextField label="Name" error="Cannot be blank." hint="Unique." />);
    const input = screen.getByLabelText("Name");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = input.getAttribute("aria-describedby")!.split(" ");
    const texts = described.map(
      (id) => document.getElementById(id)!.textContent,
    );
    expect(texts).toContain("Cannot be blank.");
    expect(texts).toContain("Unique.");
  });

  test("Tabs move with ArrowRight and ArrowLeft", async () => {
    const user = userEvent.setup({ delay: null });
    function Host() {
      const [value, setValue] = useState("a");
      return (
        <Tabs
          label="Sections"
          value={value}
          onChange={setValue}
          tabs={[
            { value: "a", label: "Alpha" },
            { value: "b", label: "Beta" },
            { value: "c", label: "Gamma" },
          ]}
        />
      );
    }
    render(<Host />);
    const alpha = screen.getByRole("tab", { name: "Alpha" });
    alpha.focus();
    await user.keyboard("{ArrowRight}");
    const beta = screen.getByRole("tab", { name: "Beta" });
    expect(beta.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(beta);
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(
      screen.getByRole("tab", { name: "Gamma" }).getAttribute("aria-selected"),
    ).toBe("true");
  });
});

test("Esc in a nested Dialog closes only the inner one", async () => {
  const user = userEvent.setup({ delay: null });
  function Host() {
    const [inner, setInner] = useState(false);
    const [outer, setOuter] = useState(true);
    return (
      <Dialog open={outer} onClose={() => setOuter(false)} title="Outer">
        <button onClick={() => setInner(true)}>Open inner</button>
        <Dialog open={inner} onClose={() => setInner(false)} title="Inner">
          <button>Inside inner</button>
        </Dialog>
      </Dialog>
    );
  }
  render(<Host />);
  await user.click(screen.getByRole("button", { name: "Open inner" }));
  expect(screen.getByRole("dialog", { name: "Inner" })).toBeTruthy();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Inner" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Outer" })).toBeTruthy();
});

test("a second confirm resolves the pending one with false", async () => {
  const user = userEvent.setup({ delay: null });
  const results: boolean[] = [];
  function Host() {
    const confirm = useConfirm();
    return (
      <button
        onClick={async () =>
          results.push(
            await confirm({ title: "T", message: "M", confirmLabel: "Go" }),
          )
        }
      >
        Ask
      </button>
    );
  }
  render(
    <ConfirmProvider>
      <Host />
    </ConfirmProvider>,
  );
  const ask = screen.getByRole("button", { name: "Ask" });
  await user.click(ask);
  ask.click();
  await user.click(screen.getByRole("button", { name: "Go" }));
  expect(results).toEqual([false, true]);
});

async function suggestions(el: HTMLElement, text: string) {
  const view = EditorView.findFromDOM(el)!;
  act(() => {
    view.dispatch({
      changes: { from: 0, insert: text },
      selection: { anchor: text.length },
    });
    startCompletion(view);
  });
  let labels: string[] = [];
  await waitFor(() => {
    labels = currentCompletions(view.state).map((c) => c.label);
    expect(labels.length).toBeGreaterThan(0);
  });
  return labels;
}

test("CodeArea suggests the given completions", async () => {
  render(
    <CodeArea
      label="Rule"
      value=""
      onChange={() => {}}
      completions={["@request.auth.id", "title"]}
    />,
  );
  expect(await suggestions(screen.getByLabelText("Rule"), "@req")).toEqual([
    "@request.auth.id",
  ]);
});

test("CodeArea suggests sql tables from the schema", async () => {
  render(
    <CodeArea
      label="SQL"
      language="sql"
      value=""
      onChange={() => {}}
      sqlSchema={{ posts: ["title"], _superusers: ["email"] }}
    />,
  );
  expect(
    await suggestions(screen.getByLabelText("SQL"), "SELECT * FROM pos"),
  ).toContain("posts");
});

test("CodeArea completes sql names that start with an underscore", async () => {
  render(
    <CodeArea
      label="SQL"
      language="sql"
      value=""
      onChange={() => {}}
      sqlSchema={{ _superusers: ["email"] }}
    />,
  );
  const el = screen.getByLabelText("SQL");
  expect(await suggestions(el, "SELECT * FROM _su")).toContain("_superusers");
  const view = EditorView.findFromDOM(el)!;
  setSystemTime(new Date(Date.now() + 1000));
  try {
    act(() => {
      acceptCompletion(view);
    });
  } finally {
    setSystemTime();
  }
  expect(view.state.doc.toString()).toBe("SELECT * FROM _superusers");
});
