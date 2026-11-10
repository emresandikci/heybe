import { expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { fakeServer } from "../test/fake-server";
import { renderApp } from "../test/render";

const crons = [
  { id: "__pbDBOptimize__", expression: "0 0 * * *" },
  { id: "__pbLogsCleanup__", expression: "0 */6 * * *" },
];

test("lists crons and runs one", async () => {
  const server = fakeServer()
    .on("GET", "/api/crons", () => crons)
    .on("POST", "/api/crons/:id", () => undefined);
  const { user } = renderApp({ path: "/settings/crons", server });
  const row = within(
    await screen.findByRole("row", { name: /__pbLogsCleanup__/ }),
  );
  expect(row.getByText("0 */6 * * *")).toBeTruthy();
  await user.click(row.getByRole("button", { name: "Run now" }));
  await screen.findByText("Started __pbLogsCleanup__.");
  expect(server.find("POST", "/api/crons/:id")[0]!.path).toBe(
    "/api/crons/__pbLogsCleanup__",
  );
});

test("run failure shows the server message", async () => {
  const server = fakeServer()
    .on("GET", "/api/crons", () => crons)
    .on(
      "POST",
      "/api/crons/:id",
      { status: 404, message: "Missing cron job.", data: {} },
      404,
    );
  const { user } = renderApp({ path: "/settings/crons", server });
  const row = within(
    await screen.findByRole("row", { name: /__pbDBOptimize__/ }),
  );
  await user.click(row.getByRole("button", { name: "Run now" }));
  expect(await screen.findByText("Missing cron job.")).toBeTruthy();
});
