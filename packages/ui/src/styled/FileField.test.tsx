import { expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileField } from "./FileField.js";

const file = (name: string) => new File(["x"], name, { type: "text/plain" });

test("label is linked to the file input", () => {
  render(<FileField label="Backup file" onChange={() => {}} />);
  expect((screen.getByLabelText("Backup file") as HTMLInputElement).type).toBe(
    "file",
  );
});

test("choosing a file calls onChange with the files and shows the name", async () => {
  const user = userEvent.setup({ delay: null });
  const onChange = mock();
  render(<FileField label="Backup file" onChange={onChange} />);
  const a = file("a.zip");
  await user.upload(screen.getByLabelText("Backup file"), a);
  expect(onChange).toHaveBeenCalledWith([a]);
  expect(screen.getByText("a.zip")).toBeTruthy();
});

test("dropping files calls onChange with them", () => {
  const onChange = mock();
  render(<FileField label="Backup file" onChange={onChange} />);
  const dropped = file("d.zip");
  fireEvent.drop(screen.getByTestId("file-drop"), {
    dataTransfer: { files: [dropped] },
  });
  expect(onChange).toHaveBeenCalledWith([dropped]);
  expect(screen.getByText("d.zip")).toBeTruthy();
});

test("drop is ignored when disabled", () => {
  const onChange = mock();
  render(<FileField label="Backup file" disabled onChange={onChange} />);
  fireEvent.drop(screen.getByTestId("file-drop"), {
    dataTransfer: { files: [file("d.zip")] },
  });
  expect(onChange).not.toHaveBeenCalled();
});

test("error sets aria-invalid and aria-describedby", () => {
  render(<FileField label="Backup file" error="Too big" onChange={() => {}} />);
  const input = screen.getByLabelText("Backup file");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  const id = input.getAttribute("aria-describedby")!;
  expect(document.getElementById(id)?.textContent).toBe("Too big");
});

test("choosing the same file twice fires onChange twice", async () => {
  const user = userEvent.setup({ delay: null });
  const onChange = mock();
  render(<FileField label="Backup file" onChange={onChange} />);
  const input = screen.getByLabelText("Backup file") as HTMLInputElement;
  const a = file("a.zip");
  await user.upload(input, a);
  expect(input.value).toBe("");
  await user.upload(input, a);
  expect(onChange).toHaveBeenCalledTimes(2);
});
