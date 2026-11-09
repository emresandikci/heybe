import type { App } from "../app";
import { mfaDurationMs } from "../auth/mfa";
import { otpDurationMs } from "../auth/otp";
import type { Collection } from "../collections/model";
import { exclusive } from "../db";
import { deleteOldLogs } from "../logs/logger";
import { internalRecords } from "../records/internal";
import { formatDate } from "../util";

// System jobs and lifecycle of PB core/base.go and core/{otp,mfa}_query.go.

const CLEANUPS = [
  ["_mfas", "MFA", mfaDurationMs],
  ["_otps", "OTP", otpDurationMs],
] as const;

async function deleteExpired(
  app: App,
  table: string,
  durationMs: (c: Collection) => number,
): Promise<void> {
  for (const c of app.collections.all()) {
    if (c.type !== "auth") continue;
    const oldest = new Date(app.now().getTime() - durationMs(c));
    await app.db.write(() =>
      internalRecords(app, table).deleteWhere(
        "collectionRef = ? AND created < ?",
        [c.id, formatDate(oldest)],
      ),
    );
  }
}

export function registerCronJobs(app: App): void {
  app.onServe(
    (e) => {
      app.scheduler.start();
      return e.next();
    },
    { id: "__pbCronStart__", priority: 999 },
  );
  app.onBootstrapClear(
    async (e) => {
      await app.scheduler.stop();
      return e.next();
    },
    { id: "__pbCronStop__", priority: 999 },
  );

  app.scheduler.add("__pbDBOptimize__", "0 0 * * *", async () => {
    try {
      await exclusive(app.db, (s) => s.run("PRAGMA wal_checkpoint(TRUNCATE)"));
    } catch (error) {
      app.logger.warn(
        "Failed to run periodic PRAGMA wal_checkpoint for the main DB",
        { error },
      );
    }
    try {
      await exclusive(app.auxDb, (s) =>
        s.run("PRAGMA wal_checkpoint(TRUNCATE)"),
      );
    } catch (error) {
      app.logger.warn(
        "Failed to run periodic PRAGMA wal_checkpoint for the auxiliary DB",
        { error },
      );
    }
    try {
      await exclusive(app.db, (s) => s.run("PRAGMA optimize"));
    } catch (error) {
      app.logger.warn("Failed to run periodic PRAGMA optimize", { error });
    }
  });
  for (const [table, label, durationMs] of CLEANUPS)
    app.scheduler.add(`__pb${label}Cleanup__`, "0 * * * *", () =>
      deleteExpired(app, table, durationMs).catch((error) =>
        app.logger.warn(`Failed to delete expired ${label} sessions`, {
          error,
        }),
      ),
    );
  app.scheduler.add("__pbLogsCleanup__", "0 */6 * * *", () =>
    deleteOldLogs(app, app.settings.get().logs.maxDays).catch((error) =>
      app.logger.warn("Failed to delete old logs", { error }),
    ),
  );
}
