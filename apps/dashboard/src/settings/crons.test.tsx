import { expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { fakeServer } from "../test/fake-server";
import { renderApp } from "../test/render";

const crons = [
  { id: "__hbDBOptimize__", expression: "0 0 * * *" },
  { id: "__hbLogsCleanup__", expression: "0 */6 * * *" },
];

test("lists crons and runs one", async () => {
  const server = fakeServer()
    .on("GET", "/api/crons", () => crons)
    .on("POST", "/api/crons/:id", () => undefined);
  const { user } = renderApp({ path: "/settings/crons", server });
  const row = within(
    await screen.findByRole("row", { name: /__hbLogsCleanup__/ }),
  );
  expect(row.getByText("0 */6 * * *")).toBeTruthy();
  await user.click(row.getByRole("button", { name: "Run now" }));
  await screen.findByText("Started __hbLogsCleanup__.");
  expect(server.find("POST", "/api/crons/:id")[0]!.path).toBe(
    "/api/crons/__hbLogsCleanup__",
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
    await screen.findByRole("row", { name: /__hbDBOptimize__/ }),
  );
  await user.click(row.getByRole("button", { name: "Run now" }));
  expect(await screen.findByText("Missing cron job.")).toBeTruthy();
});

test("shows a readable schedule next to the expression", async () => {
  const server = fakeServer().on("GET", "/api/crons", () => crons);
  renderApp({ path: "/settings/crons", server });
  const row = within(
    await screen.findByRole("row", { name: /__hbLogsCleanup__/ }),
  );
  expect(row.getByText("every 6 hours")).toBeTruthy();
});

test("a failed load shows the error and retries", async () => {
  let fail = true;
  const server = fakeServer().on("GET", "/api/crons", () =>
    fail
      ? new Response(
          JSON.stringify({ code: 500, message: "Boom.", data: {} }),
          {
            status: 500,
          },
        )
      : crons,
  );
  const { user } = renderApp({ path: "/settings/crons", server });
  expect(await screen.findByText("Boom.")).toBeTruthy();
  fail = false;
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("row", { name: /__hbLogsCleanup__/ }),
  ).toBeTruthy();
});
