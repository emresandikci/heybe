import { expect, test } from "bun:test";
import { useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setCode } from "../../test/editor";
import { EditorInput, EditorSkeleton } from "./EditorInput";

function Harness({
  initial,
  onValue,
}: {
  initial: string;
  onValue?: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <EditorInput
        name="body"
        value={value}
        disabled={false}
        onChange={(v) => {
          setValue(v);
          onValue?.(v);
        }}
      />
      <button onClick={() => setValue("<p>reset</p>")}>reset</button>
    </>
  );
}

const textbox = () => screen.findByRole("textbox", { name: "body" });

test("the skeleton is labelled like the field", () => {
  render(<EditorSkeleton name="body" />);
  expect(screen.getByText("body")).toBeTruthy();
  expect(
    screen.getByRole("status", { name: "Loading body editor" }),
  ).toBeTruthy();
});

test("the editor renders the initial HTML", async () => {
  render(<Harness initial="<p>Hi</p>" />);
  const box = await textbox();
  await waitFor(() => expect(box.innerHTML).toBe("<p>Hi</p>"));
});

test("bold toolbar action produces strong in the value", async () => {
  const user = userEvent.setup();
  const values: string[] = [];
  render(<Harness initial="" onValue={(v) => values.push(v)} />);
  await textbox();
  await user.click(screen.getByRole("button", { name: "Bold" }));
  await act(async () => {
    (await textbox()).focus();
  });
  await user.keyboard("hey");
  await waitFor(() =>
    expect(values.at(-1)).toBe("<p><strong>hey</strong></p>"),
  );
});

test("an emptied document emits an empty string", async () => {
  const values: string[] = [];
  const user = userEvent.setup();
  render(<Harness initial="<p>x</p>" onValue={(v) => values.push(v)} />);
  const box = await textbox();
  await act(async () => box.focus());
  await user.keyboard("{Control>}a{/Control}{Backspace}");
  await waitFor(() => expect(values.at(-1)).toBe(""));
});

test("an external value change updates the editor", async () => {
  const user = userEvent.setup();
  render(<Harness initial="<p>Hi</p>" />);
  await textbox();
  await user.click(screen.getByRole("button", { name: "reset" }));
  await waitFor(async () =>
    expect((await textbox()).innerHTML).toBe("<p>reset</p>"),
  );
});

test("the HTML toggle shows the raw HTML and re-parses on the way back", async () => {
  const user = userEvent.setup();
  render(<Harness initial="<p>Hi</p>" />);
  await textbox();
  await user.click(screen.getByRole("button", { name: "HTML" }));
  expect(document.querySelector(".hb-rich")).toBeNull();
  expect(document.querySelector(".cm-content")?.textContent).toBe("<p>Hi</p>");
  setCode(document.querySelector(".cm-content")!, "<h2>Edited</h2>");
  await user.click(screen.getByRole("button", { name: "Rich text" }));
  expect((await textbox()).innerHTML).toBe("<h2>Edited</h2>");
});

test("toolbar buttons have accessible names", async () => {
  render(<Harness initial="" />);
  await textbox();
  for (const name of [
    "Bold",
    "Italic",
    "Strikethrough",
    "Inline code",
    "Heading 2",
    "Heading 3",
    "Bullet list",
    "Ordered list",
    "Blockquote",
    "Code block",
    "Link",
    "Undo",
    "Redo",
    "HTML",
  ])
    expect(screen.getByRole("button", { name })).toBeTruthy();
});

test("disabled makes the editor read-only", async () => {
  render(
    <EditorInput name="body" value="<p>x</p>" disabled onChange={() => {}} />,
  );
  const box = await textbox();
  await waitFor(() =>
    expect(box.getAttribute("contenteditable")).toBe("false"),
  );
  expect(
    (screen.getByRole("button", { name: "Bold" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("mount and disabled toggles never call onChange", async () => {
  const calls: string[] = [];
  const props = { name: "body", onChange: (v: string) => calls.push(v) };
  const { rerender } = render(
    <EditorInput {...props} value="plain" disabled={false} />,
  );
  await textbox();
  rerender(<EditorInput {...props} value="plain" disabled />);
  rerender(<EditorInput {...props} value="plain" disabled={false} />);
  await textbox();
  expect(calls).toEqual([]);
});

const table = "<table><tbody><tr><td>a</td></tr></tbody></table>";

test("unsupported HTML opens in HTML mode and stays byte-identical", async () => {
  const calls: string[] = [];
  render(
    <EditorInput
      name="body"
      value={table}
      disabled={false}
      onChange={(v) => calls.push(v)}
    />,
  );
  await waitFor(() =>
    expect(document.querySelector(".cm-content")?.textContent).toBe(table),
  );
  expect(document.querySelector(".hb-rich")).toBeNull();
  expect(
    screen.getByText(/does not support; edit it as HTML/, { exact: false }),
  ).toBeTruthy();
  expect(calls).toEqual([]);
});

test("normalization-only differences stay in the visual editor", async () => {
  render(
    <EditorInput
      name="body"
      value={"<p>a <b>b</b></p>\n<p><i>c</i></p>"}
      disabled={false}
      onChange={() => {}}
    />,
  );
  await textbox();
  expect(document.querySelector(".cm-content")).toBeNull();
});

const focused = () =>
  document.activeElement?.getAttribute("aria-label") ??
  document.activeElement?.textContent;

test("the toolbar is a roving tab stop with arrow, Home and End keys", async () => {
  const user = userEvent.setup();
  render(<Harness initial="<p>x</p>" />);
  await textbox();
  const toolbar = screen.getByRole("toolbar");
  const stops = () =>
    [...toolbar.querySelectorAll("button")].filter((b) => b.tabIndex === 0);
  expect(
    stops().map((b) => b.getAttribute("aria-label") ?? b.textContent),
  ).toEqual(["Bold"]);
  act(() => screen.getByRole("button", { name: "Bold" }).focus());
  await user.keyboard("{ArrowRight}");
  expect(focused()).toBe("Italic");
  expect(stops()).toHaveLength(1);
  await user.keyboard("{End}");
  expect(focused()).toBe("HTML");
  await user.keyboard("{ArrowRight}");
  expect(focused()).toBe("Bold");
  await user.keyboard("{ArrowLeft}");
  expect(focused()).toBe("HTML");
  await user.keyboard("{Home}");
  expect(focused()).toBe("Bold");
});

async function applyLink(url: string) {
  const user = userEvent.setup();
  render(<Harness initial="<p>hi</p>" />);
  const box = await textbox();
  await act(async () => box.focus());
  await user.keyboard("{Control>}a{/Control}");
  await user.click(screen.getByRole("button", { name: "Link" }));
  fireEvent.change(await screen.findByLabelText("Link URL"), {
    target: { value: url },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  return box;
}

test("a link URL is applied to the selection", async () => {
  const box = await applyLink("https://example.com");
  await waitFor(() =>
    expect(box.innerHTML).toContain('href="https://example.com'),
  );
});

test("a javascript: link URL is rejected", async () => {
  const box = await applyLink("javascript:alert(1)");
  const input = screen.getByLabelText("Link URL");
  const message = screen.getByText("Enter an http, https or mailto URL.");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(input.getAttribute("aria-describedby")).toBe(message.id);
  expect(box.innerHTML).not.toContain("javascript");
  expect(box.querySelector("a")).toBeNull();
});

test("plain text opens in the visual editor without calling onChange", async () => {
  const calls: string[] = [];
  render(
    <EditorInput
      name="body"
      value={"line one\nline two"}
      disabled={false}
      onChange={(v) => calls.push(v)}
    />,
  );
  await textbox();
  expect(document.querySelector(".cm-content")).toBeNull();
  expect(calls).toEqual([]);
});
