import { expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { fakeServer } from "../test/fake-server";
import { setCode } from "../test/editor";
import { renderApp } from "../test/render";
import { changesRows } from "./SqlPage";

const result = {
  execTime: 3,
  affectedRows: 0,
  columns: [
    { name: "id", type: "TEXT", nullable: false },
    { name: "title", type: "TEXT", nullable: true },
  ],
  rows: [
    ["a1", "<b>x</b>"],
    ["a2", null],
  ],
};

async function openSql(reply: object | (() => unknown) = result, status = 200) {
  const server = fakeServer().on("POST", "/api/sql", reply as never, status);
  const app = renderApp({ path: "/settings/sql", server });
  await screen.findByLabelText("SQL query");
  return { ...app, server };
}

test("shows the warning", async () => {
  await openSql();
  expect(
    screen.getByText(
      "Queries run directly on the database. They skip API rules, hooks and migrations.",
    ),
  ).toBeTruthy();
});

test("SQL Run posts the query and renders columns, rows and NULL", async () => {
  const { user, server } = await openSql();
  setCode(screen.getByLabelText("SQL query"), "SELECT id, title FROM posts");
  await user.click(screen.getByRole("button", { name: "Run" }));
  expect(await screen.findByText("2 rows, 0 affected, 3 ms")).toBeTruthy();
  expect(server.find("POST", "/api/sql")[0]!.body).toEqual({
    query: "SELECT id, title FROM posts",
  });
  expect(screen.getByRole("columnheader", { name: "title" })).toBeTruthy();
  expect(screen.getByText("<b>x</b>")).toBeTruthy();
  expect(screen.getByText("NULL")).toBeTruthy();
});

test("a write shows affectedRows", async () => {
  const { user } = await openSql({
    execTime: 1,
    affectedRows: 5,
    columns: [],
    rows: [],
  });
  setCode(screen.getByLabelText("SQL query"), "DELETE FROM posts");
  await user.click(screen.getByRole("button", { name: "Run" }));
  const dialog = within(
    await screen.findByRole("dialog", { name: "Run query" }),
  );
  await user.click(dialog.getByRole("button", { name: "Run" }));
  expect(await screen.findByText("0 rows, 5 affected, 1 ms")).toBeTruthy();
});

test("cancelling the confirm does not run a delete or update", async () => {
  const { user, server } = await openSql();
  setCode(screen.getByLabelText("SQL query"), "UPDATE posts SET title = 'x'");
  await user.click(screen.getByRole("button", { name: "Run" }));
  const dialog = within(
    await screen.findByRole("dialog", { name: "Run query" }),
  );
  await user.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(server.find("POST", "/api/sql")).toEqual([]);
});

test("changesRows finds delete and update anywhere but not in strings or comments", () => {
  expect(changesRows("delete from posts")).toBe(true);
  expect(
    changesRows("WITH x AS (SELECT id FROM posts) UPDATE posts SET a = 1"),
  ).toBe(true);
  expect(changesRows("SELECT 1;\nDELETE FROM posts")).toBe(true);
  expect(changesRows("SELECT * FROM posts")).toBe(false);
  expect(changesRows("SELECT 'delete' AS a, \"update\" FROM t")).toBe(false);
  expect(changesRows("SELECT 1 -- delete later")).toBe(false);
  expect(changesRows("SELECT updated, deleted_at FROM posts")).toBe(false);
});

test("Ctrl+Enter runs the query", async () => {
  const { user, server } = await openSql();
  const sql = screen.getByLabelText("SQL query");
  setCode(sql, "SELECT 1");
  sql.focus();
  await user.keyboard("{Control>}{Enter}{/Control}");
  await screen.findByText("2 rows, 0 affected, 3 ms");
  expect(server.find("POST", "/api/sql")).toHaveLength(1);
});

test("an SQL error shows the server message", async () => {
  const { user } = await openSql(
    { status: 400, message: "SQL logic error: no such table: x (1)", data: {} },
    400,
  );
  setCode(screen.getByLabelText("SQL query"), "SELECT * FROM x");
  await user.click(screen.getByRole("button", { name: "Run" }));
  expect(
    await screen.findByText("SQL logic error: no such table: x (1)"),
  ).toBeTruthy();
});

test("an empty query is not sent", async () => {
  const { user, server } = await openSql();
  await user.click(screen.getByRole("button", { name: "Run" }));
  expect(server.find("POST", "/api/sql")).toHaveLength(0);
});
