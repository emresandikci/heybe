import { expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { fakeServer, type FakeServer } from "../test/fake-server";
import { settingsFixture } from "../test/fixtures";
import { renderApp } from "../test/render";
import { LogsChart } from "./LogsChart";

const EXCLUDE = 'data.auth != "_superusers"';

const logs = [
  {
    id: "l1",
    created: "2026-11-11 10:00:00.000Z",
    level: 0,
    message: "GET /api/x",
    data: { method: "GET", url: "/api/x", status: 200, note: "<b>hi</b>" },
  },
  {
    id: "l2",
    created: "2026-11-11 10:01:00.000Z",
    level: 8,
    message: "boom",
    data: { error: "bad" },
  },
  {
    id: "l3",
    created: "2026-11-11 10:02:00.000Z",
    level: -4,
    message: "debugging",
    data: {},
  },
  {
    id: "l4",
    created: "2026-11-11 10:03:00.000Z",
    level: 4,
    message: "careful",
    data: {},
  },
];

const stats = [
  { date: "2026-11-11 10:00:00.000Z", total: 3 },
  { date: "2026-11-11 11:00:00.000Z", total: 6 },
];

function serve(extra: (s: FakeServer) => void = () => {}) {
  const server = fakeServer()
    .on("GET", "/api/logs", (req) => {
      const page = Number(req.query.get("page") ?? 1);
      return {
        page,
        perPage: 50,
        totalItems: 4,
        totalPages: 1,
        items: logs,
      };
    })
    .on("GET", "/api/logs/:id", (req) =>
      logs.find((l) => req.path.endsWith(l.id)),
    )
    .on("GET", "/api/logs/stats", () => stats)
    .on("PATCH", "/api/settings", (req) => ({
      ...settingsFixture,
      ...(req.body as object),
    }));
  extra(server);
  return server;
}

const lastQuery = (server: FakeServer, path: string) =>
  server.find("GET", path).at(-1)!.query;

test("logs list sends perPage 50, sort -@rowid and the superuser exclusion filter", async () => {
  const server = serve();
  renderApp({ path: "/logs", server });
  await screen.findByText("boom");
  const q = lastQuery(server, "/api/logs");
  expect(q.get("perPage")).toBe("50");
  expect(q.get("sort")).toBe("-@rowid");
  expect(q.get("filter")).toBe(EXCLUDE);
});

test("the user filter is combined with the exclusion", async () => {
  const server = serve();
  renderApp({ path: "/logs?filter=level%3E0", server });
  await screen.findByText("boom");
  expect(lastQuery(server, "/api/logs").get("filter")).toBe(
    `(level>0) && (${EXCLUDE})`,
  );
});

test("checking Include superuser requests drops the exclusion", async () => {
  const server = serve();
  const { user } = renderApp({ path: "/logs", server });
  await screen.findByText("boom");
  await user.click(screen.getByLabelText("Include superuser requests"));
  await screen.findByText("boom");
  expect(lastQuery(server, "/api/logs").get("filter")).toBeNull();
  expect(lastQuery(server, "/api/logs/stats").get("filter")).toBeNull();
});

test("stats use the same filter", async () => {
  const server = serve();
  renderApp({ path: "/logs", server });
  await screen.findByText("boom");
  expect(lastQuery(server, "/api/logs/stats").get("filter")).toBe(EXCLUDE);
});

test("the chart draws one bar per entry with a title", async () => {
  renderApp({ path: "/logs", server: serve() });
  const chart = await screen.findByRole("img", {
    name: "Requests per hour, 9 in total",
  });
  expect(chart.querySelectorAll("rect")).toHaveLength(2);
  const titles = [...chart.querySelectorAll("title")].map((t) => t.textContent);
  expect(titles).toEqual([
    "2026-11-11 10:00:00 UTC: 3",
    "2026-11-11 11:00:00 UTC: 6",
  ]);
  const heights = [...chart.querySelectorAll("rect")].map((r) =>
    Number(r.getAttribute("height")),
  );
  expect(heights[1]).toBeGreaterThan(heights[0]!);
});

test("the chart shows an empty state", () => {
  render(<LogsChart stats={[]} />);
  expect(screen.getByText("No logs for this filter.")).toBeTruthy();
});

test("levels render as DEBUG, INFO, WARN and ERROR", async () => {
  renderApp({ path: "/logs", server: serve() });
  const rows = await screen.findAllByRole("row");
  const text = rows.map((r) => r.textContent);
  expect(
    text.some((t) => t!.includes("INFO") && t!.includes("GET /api/x")),
  ).toBe(true);
  expect(text.some((t) => t!.includes("ERROR") && t!.includes("boom"))).toBe(
    true,
  );
  expect(text.some((t) => t!.includes("DEBUG"))).toBe(true);
  expect(text.some((t) => t!.includes("WARN"))).toBe(true);
});

test("the request column shows method, url and status", async () => {
  renderApp({ path: "/logs", server: serve() });
  expect(await screen.findByText("GET /api/x 200")).toBeTruthy();
});

test("opening a log loads findOne and lists data keys as text", async () => {
  const server = serve();
  const { user } = renderApp({ path: "/logs", server });
  await user.click(await screen.findByRole("button", { name: "GET /api/x" }));
  const dialog = within(
    await screen.findByRole("dialog", { name: "Log details" }),
  );
  expect(await dialog.findByText("method")).toBeTruthy();
  expect(dialog.getByText("GET")).toBeTruthy();
  expect(dialog.getByText("<b>hi</b>")).toBeTruthy();
  expect(dialog.getByRole("button", { name: "Copy JSON" })).toBeTruthy();
  expect(server.find("GET", "/api/logs/l1")).toHaveLength(1);
});

test("a log id in the url opens the dialog", async () => {
  renderApp({ path: "/logs?log=l2", server: serve() });
  const dialog = within(
    await screen.findByRole("dialog", { name: "Log details" }),
  );
  expect(await dialog.findByText("error")).toBeTruthy();
});

test("a bad filter shows the server message", async () => {
  const server = serve();
  server.on(
    "GET",
    "/api/logs",
    {
      status: 400,
      message: "Something went wrong while processing your request.",
      data: {},
    },
    400,
  );
  renderApp({ path: "/logs?filter=%3D%3D", server });
  expect(
    await screen.findByText(
      "Something went wrong while processing your request.",
    ),
  ).toBeTruthy();
});

test("logs settings PATCH logs", async () => {
  const server = serve();
  const { user } = renderApp({ path: "/logs", server });
  await user.click(
    await screen.findByRole("button", { name: "Logs settings" }),
  );
  const dialog = within(screen.getByRole("dialog", { name: "Logs settings" }));
  const days = dialog.getByLabelText("Retention (days)");
  await user.clear(days);
  await user.type(days, "30");
  await user.selectOptions(dialog.getByLabelText("Min level"), "4");
  await user.click(dialog.getByLabelText("Log IP addresses"));
  await user.click(dialog.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Settings saved.");
  expect(server.find("PATCH", "/api/settings")[0]!.body).toEqual({
    logs: { ...settingsFixture.logs, maxDays: 30, minLevel: 4, logIP: false },
  });
});

test("Refresh refetches the list", async () => {
  const server = serve();
  const { user } = renderApp({ path: "/logs", server });
  await screen.findByText("boom");
  const before = server.find("GET", "/api/logs").length;
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("boom");
  expect(server.find("GET", "/api/logs").length).toBeGreaterThan(before);
});

test("Load more fetches the next page", async () => {
  const server = serve();
  server.on("GET", "/api/logs", (req) => {
    const page = Number(req.query.get("page") ?? 1);
    return {
      page,
      perPage: 50,
      totalItems: 51,
      totalPages: 2,
      items:
        page === 1 ? logs : [{ ...logs[0], id: "l9", message: "second page" }],
    };
  });
  const { user } = renderApp({ path: "/logs", server });
  await screen.findByText("boom");
  await user.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("second page")).toBeTruthy();
  expect(screen.getByText("boom")).toBeTruthy();
});
