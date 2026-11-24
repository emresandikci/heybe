import { expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { fakeServer, type FakeServer } from "../test/fake-server";
import { settingsFixture } from "../test/fixtures";
import { completionLabels } from "../test/editor";
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

test("the chart has a baseline, y ticks and one bar per hour in the range", async () => {
  renderApp({ path: "/logs", server: serve() });
  const chart = await screen.findByRole("img", {
    name: "Requests per hour, 9 in total",
  });
  const bars = [...chart.querySelectorAll<HTMLElement>("[data-bar]")];
  expect(bars).toHaveLength(24);
  const heights = bars.map((b) => parseFloat(b.style.height));
  expect(heights.filter((h) => h > 0)).toEqual([50, 100]);
  expect(heights.slice(-2)).toEqual([50, 100]);
  expect(within(chart).getByText("6")).toBeTruthy();
  expect(within(chart).getByText("3")).toBeTruthy();
  expect(within(chart).getByText("0")).toBeTruthy();
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
    text.some((t) => t!.includes("INFO") && t!.includes("GET 200 /api/x")),
  ).toBe(true);
  expect(text.some((t) => t!.includes("ERROR") && t!.includes("boom"))).toBe(
    true,
  );
  expect(text.some((t) => t!.includes("DEBUG"))).toBe(true);
  expect(text.some((t) => t!.includes("WARN"))).toBe(true);
});

test("request logs show method, status and url once", async () => {
  renderApp({ path: "/logs", server: serve() });
  expect(await screen.findByText("GET 200 /api/x")).toBeTruthy();
});

test("opening a log loads findOne and lists data keys as text", async () => {
  const server = serve();
  const { user } = renderApp({ path: "/logs", server });
  await user.click(await screen.findByText("GET 200 /api/x"));
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

test("a bad filter names the filter as invalid", async () => {
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
      "Invalid filter. Check the syntax and field names.",
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
  const save = dialog.getByRole("button", { name: "Save changes" });
  expect(save.closest("[data-part=footer]")).not.toBeNull();
  await user.click(save);
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
        page === 1
          ? logs
          : [{ ...logs[0], id: "l9", message: "second page", data: {} }],
    };
  });
  const { user } = renderApp({ path: "/logs", server });
  await screen.findByText("boom");
  await user.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("second page")).toBeTruthy();
  expect(screen.getByText("boom")).toBeTruthy();
});

test("each log has a named button that opens details from the keyboard", async () => {
  const { user } = renderApp({ path: "/logs", server: serve() });
  const button = await screen.findByRole("button", { name: "boom" });
  button.focus();
  await user.keyboard("{Enter}");
  expect(
    await screen.findByRole("dialog", { name: "Log details" }),
  ).toBeTruthy();
});

test("the filter placeholder is log specific", async () => {
  renderApp({ path: "/logs", server: serve() });
  await screen.findByLabelText("Filter logs");
  expect(document.querySelector(".cm-placeholder")!.textContent).toBe(
    "e.g. level >= 8 && data.status >= 400",
  );
});

test("invalid filter shows the error and keeps the page", async () => {
  const server = serve();
  server.on(
    "GET",
    "/api/logs",
    { status: 400, message: "Invalid filter.", data: {} },
    400,
  );
  server.on(
    "GET",
    "/api/logs/stats",
    { status: 400, message: "Invalid filter.", data: {} },
    400,
  );
  renderApp({ path: "/logs?filter=%3D%3D", server });
  expect(
    await screen.findByText(
      "Invalid filter. Check the syntax and field names.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("No logs for this filter.")).toBeTruthy();
  expect(screen.getByRole("table", { name: "Logs" })).toBeTruthy();
  expect(screen.getByRole("heading", { level: 1, name: "Logs" })).toBeTruthy();
});

test("log details shows the full local date", async () => {
  renderApp({ path: "/logs?log=l1", server: serve() });
  const dialog = within(
    await screen.findByRole("dialog", { name: "Log details" }),
  );
  expect(await dialog.findByText(/^Nov 11, 2026, .*:00 /)).toBeTruthy();
});

test("log details hides empty values", async () => {
  const server = serve();
  server.on("GET", "/api/logs/l1", {
    ...logs[0],
    data: { auth: "", status: 200, empty: null },
  });
  renderApp({ path: "/logs?log=l1", server });
  const dialog = within(
    await screen.findByRole("dialog", { name: "Log details" }),
  );
  await dialog.findByText("status");
  expect(dialog.queryByText("auth")).toBeNull();
  expect(dialog.queryByText("empty")).toBeNull();
});

test("message cell is flexible", async () => {
  renderApp({ path: "/logs", server: serve() });
  const button = await screen.findByRole("button", { name: "boom" });
  expect(button.className).toContain("truncate");
  expect(button.closest("td")!.className).toContain("max-w-0");
});

test("the footer shows the total", async () => {
  renderApp({ path: "/logs", server: serve() });
  await screen.findByText("boom");
  expect(screen.getByText("Total: 4")).toBeTruthy();
});

test("the logs filter suggests log fields", async () => {
  renderApp({ path: "/logs", server: serve() });
  const input = await screen.findByLabelText("Filter logs");
  expect(await completionLabels(input, "data.st")).toContain(
    "data.status number",
  );
});

test("an empty log list says so", async () => {
  const server = serve((s) =>
    s.on("GET", "/api/logs", {
      page: 1,
      perPage: 50,
      totalItems: 0,
      totalPages: 1,
      items: [],
    }),
  );
  renderApp({ path: "/logs", server });
  await screen.findByText("No logs yet.");
  expect(screen.queryByRole("table", { name: "Logs" })).toBeNull();
});
