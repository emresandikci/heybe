import type { App } from "../../app";
import { exclusive } from "../../db";
import { type SimpleFields, compileSimpleQuery } from "../../filter/simple";
import { requireSuperuserAuth, skipSuccessActivityLog } from "../middlewares";
import { checkFilterAndSortLimits, parseListQuery } from "../list-query";
import { type RequestEvent, type Router, markListResult } from "../router";

const LOG_FIELDS: SimpleFields = {
  columns: ["id", "created", "level", "message", "data"],
  json: { column: "data", pattern: /^data\.[\w.:]*\w+$/ },
};

interface LogRow {
  id: string;
  created: string;
  level: number;
  message: string;
  data: string;
}

const toLog = (row: LogRow) => ({
  id: row.id,
  created: row.created,
  data: JSON.parse(row.data),
  message: row.message,
  level: row.level,
});

function list(e: RequestEvent) {
  try {
    const { page, perPage, skipTotal } = parseListQuery(e.query);
    const filter = e.query.get("filter") ?? "";
    const sort = e.query.get("sort") ?? "";
    checkFilterAndSortLimits(filter, sort);
    const { where, orderBy, params } = compileSimpleQuery(
      filter,
      sort,
      e.app.now,
      LOG_FIELDS,
    );
    const n = params.length;
    const rows = e.app.auxDb.query<LogRow>(
      `SELECT * FROM _logs WHERE ${where}${orderBy ? ` ORDER BY ${orderBy}` : ""} LIMIT ?${n + 1} OFFSET ?${n + 2}`,
      [...params, perPage, perPage * (page - 1)],
    );
    const totalItems = skipTotal
      ? -1
      : e.app.auxDb.get<{ n: number }>(
          `SELECT count(*) AS n FROM _logs WHERE ${where}`,
          params,
        )!.n;
    return e.json(
      200,
      markListResult({
        page,
        perPage,
        totalItems,
        totalPages: skipTotal ? -1 : Math.ceil(totalItems / perPage),
        items: rows.map(toLog),
      }),
    );
  } catch {
    throw e.badRequestError();
  }
}

function stats(e: RequestEvent) {
  let query: ReturnType<typeof compileSimpleQuery>;
  try {
    query = compileSimpleQuery(
      e.query.get("filter") ?? "",
      "",
      e.app.now,
      LOG_FIELDS,
    );
  } catch {
    throw e.badRequestError("Invalid filter format.");
  }
  try {
    const rows = e.app.auxDb.query<{ total: number; date: string }>(
      `SELECT count(id) AS total, strftime('%Y-%m-%d %H:00:00', created) AS date FROM _logs WHERE ${query.where} GROUP BY date`,
      query.params,
    );
    return e.json(
      200,
      rows.map(({ total, date }) => ({ date: `${date}.000Z`, total })),
    );
  } catch {
    throw e.badRequestError("Failed to generate logs stats.");
  }
}

function view(e: RequestEvent) {
  const row = e.app.auxDb.get<LogRow>("SELECT * FROM _logs WHERE id = ?", [
    e.params.id,
  ]);
  if (!row) throw e.notFoundError();
  return e.json(200, toLog(row));
}

async function truncate(app: App, e: RequestEvent) {
  try {
    await app.auxDb.write(() => app.auxDb.run("DELETE FROM _logs"));
  } catch {
    throw e.internalServerError("Failed to truncate all logs.");
  }
  try {
    await exclusive(app.auxDb, (s) => s.run("VACUUM"));
  } catch (error) {
    app.logger.warn("Failed to VACUUM aux database", { error });
  }
  return e.noContent(204);
}

export function registerLogsRoutes(router: Router): void {
  const group = router
    .group("/api/logs")
    .use(requireSuperuserAuth(), skipSuccessActivityLog());
  group.get("", list);
  group.delete("", (e) => truncate(e.app, e));
  group.get("/stats", stats);
  group.get("/{id}", view);
}
