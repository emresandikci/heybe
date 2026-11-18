import { expect, setSystemTime, test } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";
import {
  acceptCompletion,
  currentCompletions,
  startCompletion,
} from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { CodeArea } from "./CodeArea.js";
import userEvent from "@testing-library/user-event";
import { Checkbox } from "./Checkbox.js";
import { RadioGroup } from "./RadioGroup.js";
import { Switch } from "./Switch.js";
import { TextField } from "./TextField.js";

test("TextField links its label, error and aria-invalid", () => {
  render(<TextField label="Name" error="Cannot be blank." hint="Unique." />);
  const input = screen.getByLabelText("Name");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  const described = input.getAttribute("aria-describedby")!.split(" ");
  const texts = described.map((id) => document.getElementById(id)!.textContent);
  expect(texts).toContain("Cannot be blank.");
  expect(texts).toContain("Unique.");
});

test("Switch with error links aria-describedby", () => {
  render(<Switch label="Enabled" error="Required." hint="Turn on." />);
  const described = screen
    .getByRole("switch")
    .getAttribute("aria-describedby")!
    .split(" ")
    .map((id) => document.getElementById(id)!.textContent);
  expect(described).toEqual(["Turn on.", "Required."]);
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

test("clicking the Switch label toggles it", async () => {
  const user = userEvent.setup({ delay: null });
  render(<Switch label="Enabled" />);
  await user.click(screen.getByText("Enabled"));
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
});

test("Checkbox, Switch and RadioGroup show the invalid state", () => {
  render(<Checkbox label="Agree" error="Required." />);
  expect(screen.getByRole("checkbox").className).toContain(
    "aria-[invalid=true]:outline-danger",
  );
  render(<Switch label="S" error="E" />);
  expect(screen.getByRole("switch").className).toContain(
    "aria-[invalid=true]:outline-danger",
  );
});

test("Switch off track and unchecked radio ring use the 3:1 control token", () => {
  render(<Switch label="S" />);
  expect(screen.getByRole("switch").className).toContain("bg-control");
  expect(screen.getByRole("switch").className).toContain("[&>span]:bg-thumb");
  render(
    <RadioGroup
      label="R"
      options={[{ value: "a", label: "A" }]}
      value=""
      onChange={() => {}}
    />,
  );
  expect(screen.getByRole("radiogroup").className).toContain(
    "before:border-control",
  );
});

test("CodeArea singleLine runs on Enter, has no gutter and flattens newlines", () => {
  let runs = 0;
  render(
    <CodeArea
      label="Filter"
      singleLine
      value=""
      onChange={() => {}}
      onRun={() => runs++}
    />,
  );
  const el = screen.getByLabelText("Filter");
  const view = EditorView.findFromDOM(el)!;
  expect(document.querySelector(".cm-gutters")).toBeNull();
  act(() => view.dispatch({ changes: { from: 0, insert: "a\nb" } }));
  expect(view.state.doc.toString()).toBe("a b");
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  expect(runs).toBe(1);
});

const typed = async (el: HTMLElement, text: string) => {
  const view = EditorView.findFromDOM(el)!;
  act(() => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: text.length },
      userEvent: "input.type",
    });
  });
  await waitFor(() =>
    expect(currentCompletions(view.state).length).toBeGreaterThan(0),
  );
  return currentCompletions(view.state).map((c) => c.label);
};

test("singleLine CodeArea offers operators while typing an operator and after a space", async () => {
  render(
    <CodeArea
      label="Filter"
      singleLine
      value=""
      onChange={() => {}}
      completions={["title", "&&", "!=", "="]}
    />,
  );
  const el = screen.getByLabelText("Filter");
  expect(await typed(el, "title !")).toContain("!=");
  expect(await typed(el, "title = 1 ")).toContain("&&");
  expect(await typed(el, "title = 1 &")).toContain("&&");
});

test("CodeArea suggest replaces from the returned offset and shows the detail", async () => {
  const calls: [string, number][] = [];
  render(
    <CodeArea
      label="Rule"
      value=""
      onChange={() => {}}
      suggest={(text, pos) => {
        calls.push([text, pos]);
        return {
          from: pos - 2,
          options: [{ label: "title", detail: "text" }, { label: "other" }],
        };
      }}
    />,
  );
  const el = screen.getByLabelText("Rule");
  expect(await typed(el, "x = ti")).toEqual(["title"]);
  expect(calls.at(-1)).toEqual(["x = ti", 6]);
  const view = EditorView.findFromDOM(el)!;
  expect(currentCompletions(view.state)[0]!.detail).toBe("text");
});

test("CodeArea suggest stays closed for an empty word unless singleLine or explicit", async () => {
  const options = [{ label: "title" }];
  const { unmount } = render(
    <CodeArea
      label="Rule"
      value=""
      onChange={() => {}}
      suggest={(_, pos) => ({ from: pos, options })}
    />,
  );
  const view = EditorView.findFromDOM(screen.getByLabelText("Rule"))!;
  act(() => {
    view.dispatch({
      changes: { from: 0, insert: "a " },
      selection: { anchor: 2 },
      userEvent: "input.type",
    });
  });
  expect(currentCompletions(view.state)).toEqual([]);
  expect(await suggestions(screen.getByLabelText("Rule"), "")).toEqual([
    "title",
  ]);
  unmount();

  render(
    <CodeArea
      label="Filter"
      singleLine
      value=""
      onChange={() => {}}
      suggest={(_, pos) => ({ from: pos, options })}
    />,
  );
  expect(await typed(screen.getByLabelText("Filter"), "a ")).toEqual(["title"]);
});

test("CodeArea readOnly is read-only without a gutter", () => {
  render(
    <CodeArea
      label="Code"
      language="javascript"
      readOnly
      value="const a = 1;"
      onChange={() => {}}
    />,
  );
  const el = screen.getByLabelText("Code");
  const view = EditorView.findFromDOM(el)!;
  expect(view.state.readOnly).toBe(true);
  expect(view.state.doc.toString()).toBe("const a = 1;");
  expect(document.querySelector(".cm-gutters")).toBeNull();
});

test("CodeArea highlights javascript", () => {
  render(
    <CodeArea
      label="Code"
      language="javascript"
      readOnly
      value={'const a = "x";'}
      onChange={() => {}}
    />,
  );
  expect(document.querySelectorAll(".cm-line span").length).toBeGreaterThan(1);
});

test("CodeArea hideLabel keeps the label for screen readers only", () => {
  render(<CodeArea label="Snippet" hideLabel readOnly value="a" />);
  expect(screen.getByText("Snippet").className).toContain("sr-only");
  expect(screen.getByLabelText("Snippet")).toBeTruthy();
});
