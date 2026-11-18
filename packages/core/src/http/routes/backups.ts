import { basename } from "node:path";
import type { App } from "../../app";
import { authFromToken } from "../../auth/tokens";
import { mimeExtension, sniffMime } from "../../files/mime";
import { normalizeFilename } from "../../files/name";
import { NotFoundError, errorMessage, formatDate } from "../../util";
import { ApiError, LOAD_FAILED, loadBody } from "../errors";
import {
  bodyLimit,
  checkSuperuserIp,
  requireSuperuserAuth,
} from "../middlewares";
import type { RequestEvent, Router } from "../router";
import { serveStoredFile } from "./files";

// Port of PB apis/backup.go, backup_create.go and backup_upload.go.

const VALIDATION_FAILED =
  "An error occurred while validating the submitted data.";
const ACTIVE =
  "Try again later - another backup/restore process has already been started";
const FORBIDDEN = "Insufficient permissions to access the resource.";
const NAME = /^[a-z0-9_-]+\.zip$/;
const RESTORE_DELAY = 1000;

async function list(e: RequestEvent) {
  let items;
  try {
    items = await e.app.newBackupsFilesystem().list("");
  } catch (err) {
    throw new ApiError(
      400,
      `Failed to retrieve backup items. Raw error: \n${errorMessage(err)}`,
    );
  }
  return e.json(
    200,
    items.map((f) => ({
      modified: formatDate(f.modified),
      key: f.key,
      size: f.size,
    })),
  );
}

async function nameIssue(app: App, name: string) {
  if (name === "") return null;
  if ([...name].length > 150)
    return {
      code: "validation_length_out_of_range",
      message: "The length must be between 1 and 150.",
      params: { min: 1, max: 150 },
    };
  if (!NAME.test(name))
    return {
      code: "validation_match_invalid",
      message: "Must be in a valid format.",
    };
  if (
    await app
      .newBackupsFilesystem()
      .exists(name)
      .catch(() => true)
  )
    return {
      code: "validation_backup_name_exists",
      message: "The backup file name is invalid or already exists.",
    };
  return null;
}

async function create(e: RequestEvent) {
  if (e.app.activeBackup !== null) throw new ApiError(400, ACTIVE);
  const body = await loadBody(e);
  const name = body.name ?? "";
  if (typeof name !== "string") throw new ApiError(400, LOAD_FAILED);
  const issue = await nameIssue(e.app, name);
  if (issue) throw new ApiError(400, VALIDATION_FAILED, { name: issue });
  try {
    await e.app.createBackup(name);
  } catch {
    throw new ApiError(400, "Failed to create backup.");
  }
  return e.noContent(204);
}

async function uploadIssue(app: App, file: File | undefined) {
  if (!file)
    return { code: "validation_required", message: "Cannot be blank." };
  const type = await sniffMime(file);
  if (type !== "application/zip")
    return {
      code: "validation_invalid_mime_type",
      message: `${JSON.stringify(normalizeFilename(file.name, mimeExtension(type)))} mime type must be one of: application/zip.`,
    };
  if (
    await app
      .newBackupsFilesystem()
      .exists(file.name)
      .catch(() => true)
  )
    return {
      code: "validation_backup_name_exists",
      message: "Backup file with the specified name already exists.",
    };
  return null;
}

async function upload(e: RequestEvent) {
  const [file] = await e.findUploadedFiles("file").catch(() => []);
  const issue = await uploadIssue(e.app, file);
  if (issue) throw new ApiError(400, VALIDATION_FAILED, { file: issue });
  try {
    await e.app
      .newBackupsFilesystem()
      .write(file!.name, file!, "application/zip");
  } catch {
    throw new ApiError(400, "Failed to upload backup.");
  }
  return e.noContent(204);
}

async function download(e: RequestEvent) {
  const auth = authFromToken(e.app, e.query.get("token") ?? "", "file");
  if (!auth?.isSuperuser) throw new ApiError(403, FORBIDDEN);
  try {
    checkSuperuserIp(e.app, e.req, e.remoteIp);
  } catch {
    throw new ApiError(403, FORBIDDEN);
  }
  const key = e.params.key!;
  try {
    await serveStoredFile(e, e.app.newBackupsFilesystem(), key, basename(key));
  } catch (err) {
    // PB's local driver reports a missing file as fs.ErrNotExist (404), its S3 driver as a plain error (400)
    if (
      err instanceof NotFoundError &&
      e.app.settings.current().backups.s3.enabled
    )
      throw new ApiError(400, "");
    throw err;
  }
}

async function remove(e: RequestEvent) {
  const key = e.params.key!;
  if (key !== "" && e.app.activeBackup === key)
    throw new ApiError(
      400,
      "The backup is currently being used and cannot be deleted.",
    );
  try {
    await e.app.newBackupsFilesystem().delete(key);
  } catch (err) {
    throw new ApiError(
      400,
      `Invalid or already deleted backup file. Raw error: \n${errorMessage(err)}`,
    );
  }
  return e.noContent(204);
}

async function restore(e: RequestEvent) {
  const { app } = e;
  if (app.activeBackup !== null) throw new ApiError(400, `${ACTIVE}.`);
  const key = e.params.key!;
  if (
    !(await app
      .newBackupsFilesystem()
      .exists(key)
      .catch(() => false))
  )
    throw new ApiError(400, "Missing or invalid backup file.");
  // some time to send the response before the restart
  app.timers.setTimeout(() => {
    app.restoreBackup(key).catch((err) =>
      app.logger.error("Failed to restore backup", {
        key,
        error: errorMessage(err),
      }),
    );
  }, RESTORE_DELAY);
  return e.noContent(204);
}

export function registerBackupRoutes(router: Router): void {
  const group = router.group("/api/backups");
  group.get("", list, requireSuperuserAuth());
  group.post("", create, requireSuperuserAuth());
  group.post("/upload", upload, bodyLimit(0), requireSuperuserAuth());
  group.get("/{key}", download);
  group.delete("/{key}", remove, requireSuperuserAuth());
  group.post("/{key}/restore", restore, requireSuperuserAuth());
}
