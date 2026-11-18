import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "./EmptyState.js";

test("EmptyState shows an optional icon above the title", () => {
  render(
    <EmptyState title="No records yet" icon={<svg data-testid="icon" />} />,
  );
  const icon = screen.getByTestId("icon");
  expect(
    icon.compareDocumentPosition(screen.getByText("No records yet")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
