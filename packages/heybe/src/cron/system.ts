import type { App } from "../app";
import { mfaDurationMs } from "../auth/mfa";
import { otpDurationMs } from "../auth/otp";
import type { Collection } from "../collections/model";
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
  app.onTerminate(
    (e) => {
      app.scheduler.stop();
      return e.next();
    },
    { id: "__pbCronStop__", priority: 999 },
  );

  app.scheduler.add("__pbDBOptimize__", "0 0 * * *", () => {
    try {
      app.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (err) {
      console.warn("Failed to run periodic PRAGMA wal_checkpoint", err);
    }
    try {
      app.db.run("PRAGMA optimize");
    } catch (err) {
      console.warn("Failed to run periodic PRAGMA optimize", err);
    }
  });
  for (const [table, label, durationMs] of CLEANUPS)
    app.scheduler.add(`__pb${label}Cleanup__`, "0 * * * *", () =>
      deleteExpired(app, table, durationMs).catch((err) =>
        console.warn(`Failed to delete expired ${label} sessions`, err),
      ),
    );
  app.scheduler.add("__pbLogsCleanup__", "0 */6 * * *", () => {});
}
