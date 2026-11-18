import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { HeybeError } from "@heybe/client";
import {
  ErrorScope,
  UnclaimedErrors,
  errorMessage,
  filterError,
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

  test("filterError names a rejected filter and keeps other errors", () => {
    expect(
      filterError(
        new HeybeError({
          status: 400,
          response: {
            message: "Something went wrong while processing your request.",
          },
        }),
      ),
    ).toBe("Invalid filter. Check the syntax and field names.");
    expect(
      filterError(
        new HeybeError({ status: 500, response: { message: "Down." } }),
      ),
    ).toBe("Down.");
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

  test("UnclaimedErrors hides the banner when every key is claimed inline", () => {
    const error = new HeybeError({
      response: { message: "Failed.", data: { name: { message: "Taken." } } },
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
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("UnclaimedErrors shows a message that has no field errors", () => {
    render(
      <ErrorScope error={new HeybeError({ response: { message: "Down." } })}>
        <UnclaimedErrors />
      </ErrorScope>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Down.");
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
