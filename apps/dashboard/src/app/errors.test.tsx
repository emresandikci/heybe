import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { HeybeError } from "@heybe/client";
import {
  ErrorScope,
  UnclaimedErrors,
  errorMessage,
  flattenErrors,
  useFieldError,
} from "./errors";

describe("errors", () => {
  test("flattenErrors flattens nested and array keys", () => {
    expect(
      flattenErrors({
        listRule: { message: "Invalid rule." },
        fields: { 2: { name: { message: "Cannot be blank." } } },
        indexes: [{ message: "Bad index." }],
      }),
    ).toEqual({
      listRule: "Invalid rule.",
      "fields.2.name": "Cannot be blank.",
      "indexes.0": "Bad index.",
    });
  });

  test("errorMessage prefers the response message", () => {
    expect(
      errorMessage(new HeybeError({ response: { message: "Nope." } })),
    ).toBe("Nope.");
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage(42)).toBe("Something went wrong.");
  });

  test("UnclaimedErrors lists only keys no mounted input claimed", () => {
    const error = new HeybeError({
      response: {
        message: "Failed.",
        data: {
          name: { message: "Taken." },
          "fields.0.name": { message: "Bad." },
        },
      },
    });
    function Input() {
      return <p>claimed: {useFieldError("name")}</p>;
    }
    render(
      <ErrorScope error={error}>
        <Input />
        <UnclaimedErrors />
      </ErrorScope>,
    );
    expect(screen.getByText("claimed: Taken.")).toBeTruthy();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Failed.");
    expect(alert.textContent).toContain("fields.0.name: Bad.");
    expect(alert.textContent).not.toContain("Taken.");
  });
});

test("ErrorScope updates fields passed as children when the error changes", () => {
  const failure = (message: string) =>
    new HeybeError({
      response: { message: "Failed.", data: { name: { message } } },
    });
  function Input() {
    return <p>field: {useFieldError("name") ?? "none"}</p>;
  }
  const child = <Input />;
  const view = render(<ErrorScope error={null}>{child}</ErrorScope>);
  expect(screen.getByText("field: none")).toBeTruthy();
  view.rerender(<ErrorScope error={failure("Taken.")}>{child}</ErrorScope>);
  expect(screen.getByText("field: Taken.")).toBeTruthy();
  view.rerender(<ErrorScope error={failure("Short.")}>{child}</ErrorScope>);
  expect(screen.getByText("field: Short.")).toBeTruthy();
});
