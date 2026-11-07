import type { App } from "../../app";
import { newAuthToken } from "../../auth/tokens";
import { INSTALLER_EMAIL, randomSecret } from "../../util";

const TOKEN_DURATION_SECONDS = 30 * 60;

function needsInstaller(app: App): boolean {
  const row = app.db.get<{ total: number }>(
    "SELECT COUNT(*) AS total FROM _superusers WHERE email != ?",
    [INSTALLER_EMAIL],
  );
  return row?.total === 0;
}

async function findOrCreateInstaller(
  app: App,
): Promise<Record<string, unknown>> {
  const users = app.records("_superusers");
  const existing = app.db.get<{ id: string }>(
    "SELECT id FROM _superusers WHERE email = ?",
    [INSTALLER_EMAIL],
  );
  const id =
    existing?.id ??
    (
      await users.create({
        email: INSTALLER_EMAIL,
        password: randomSecret(30),
      })
    ).id;
  return users.findRaw(id as string);
}

export async function runInstaller(
  app: App,
  baseUrl: string,
  print: (line: string) => void = console.log,
): Promise<void> {
  if (!needsInstaller(app)) return;
  const record = await findOrCreateInstaller(app);
  const token = newAuthToken(
    app,
    app.collections.find("_superusers")!,
    record,
    {
      duration: TOKEN_DURATION_SECONDS,
      refreshable: false,
    },
  );
  print(
    "\n(!) Launch the URL below in the browser if it hasn't been open already to create your first superuser account:",
  );
  print(`${baseUrl.replace(/\/+$/, "")}/_/#/pbinstall/${token}`);
  print(
    "(you can also create your first superuser by running: heybe superuser upsert EMAIL PASS)\n",
  );
}
