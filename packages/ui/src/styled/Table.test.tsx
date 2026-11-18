import { expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Table, Td, Th } from "./Table.js";

test("Td truncates string children and sets title", () => {
  const long = "x".repeat(40);
  render(
    <table>
      <tbody>
        <tr>
          <Td>{long}</Td>
        </tr>
      </tbody>
    </table>,
  );
  const cell = screen.getByRole("cell");
  expect(cell.getAttribute("title")).toBe(long);
  expect(cell.className).toContain("truncate");
  expect(cell.className).toContain("whitespace-nowrap");
  expect(cell.className).toContain("max-w-xs");
});

test("Td with wrap opts out of truncation and title", () => {
  render(
    <table>
      <tbody>
        <tr>
          <Td wrap>some text</Td>
        </tr>
      </tbody>
    </table>,
  );
  const cell = screen.getByRole("cell");
  expect(cell.getAttribute("title")).toBeNull();
  expect(cell.className).not.toContain("truncate");
});

test("Th with onSort renders a button and aria-sort", async () => {
  const onSort = mock();
  render(
    <table>
      <thead>
        <tr>
          <Th sort="desc" onSort={onSort}>
            Name
          </Th>
          <Th sort={null} onSort={onSort}>
            Date
          </Th>
        </tr>
      </thead>
    </table>,
  );
  const name = screen.getByRole("columnheader", { name: /Name/ });
  expect(name.getAttribute("aria-sort")).toBe("descending");
  expect(
    screen
      .getByRole("columnheader", { name: /Date/ })
      .getAttribute("aria-sort"),
  ).toBe("none");
  expect(name.querySelector("svg")).not.toBeNull();
  await userEvent
    .setup({ delay: null })
    .click(screen.getByRole("button", { name: /Name/ }));
  expect(onSort).toHaveBeenCalledTimes(1);
});

test("Td keeps focusable children unclipped", () => {
  render(
    <table>
      <tbody>
        <tr>
          <Td>
            <button>Edit</button>
          </Td>
        </tr>
      </tbody>
    </table>,
  );
  expect(screen.getByRole("cell").className).not.toContain("truncate");
});

test("Table stickyHeader pins header cells", () => {
  const { container } = render(
    <Table stickyHeader>
      <thead>
        <tr>
          <Th>A</Th>
        </tr>
      </thead>
    </Table>,
  );
  expect(screen.getByRole("table").hasAttribute("data-sticky-header")).toBe(
    true,
  );
  expect(container.firstElementChild!.className).toContain("overflow-auto");
});

test("Th and Td align right", () => {
  render(
    <Table>
      <thead>
        <tr>
          <Th align="right">H</Th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <Td align="right">C</Td>
        </tr>
      </tbody>
    </Table>,
  );
  expect(screen.getByRole("columnheader").className).toContain("text-right");
  expect(screen.getByRole("cell").className).toContain("text-right");
});
