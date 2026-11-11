import type { App } from "../app";
import { generateOtpCode } from "../auth/otp";
import { isEmail } from "../fields/email";
import { internalRecords } from "../records/internal";
import { ValidationError } from "../util";
import { parseCommandArgs } from "./args";
import type { CommandHelp } from "./help";

const SUPERUSERS = "_superusers";

export const superuserHelp: CommandHelp = {
  use: "superuser",
  description: "Manage superusers",
  flags: [],
  commands: [
    {
      use: "create",
      description: "Creates a new superuser",
      example: "superuser create test@example.com 1234567890",
    },
    {
      use: "delete",
      description: "Deletes an existing superuser",
      example: "superuser delete test@example.com",
    },
    {
      use: "ips",
      description:
        "Updates the superuser IPs whitelist setting (the IPs/subnets arguments must be space separated; leave empty to clear the whitelist restriction)",
      example: "superuser ips 127.0.0.1 10.0.0.0/24",
    },
    {
      use: "otp",
      description: "Creates a new OTP for the specified superuser",
      example: "superuser otp test@example.com",
    },
    {
      use: "update",
      description: "Changes the password of a single superuser",
      example: "superuser update test@example.com 1234567890",
    },
    {
      use: "upsert",
      description: "Creates, or updates if email exists, a single superuser",
      example: "superuser upsert test@example.com 1234567890",
    },
  ],
};

function formatErrors(errors: Record<string, unknown>): string {
  const parts = Object.keys(errors)
    .sort()
    .map((key) => {
      const value = errors[key] as Record<string, unknown>;
      return typeof value.message === "string"
        ? `${key}: ${value.message}`
        : `${key}: (${formatErrors(value)})`;
    });
  return `${parts.join("; ")}.`;
}

function describe(err: unknown): string {
  if (err instanceof ValidationError && Object.keys(err.data).length > 0)
    return formatErrors(err.data);
  return err instanceof Error ? err.message : String(err);
}

async function failing<T>(message: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new Error(`${message}: ${describe(err)}`);
  }
}

async function findSuperuser(
  app: App,
  email: string,
): Promise<{ id: string; email: string } | null> {
  const { items } = await app
    .records(SUPERUSERS)
    .findMany({ where: { email }, perPage: 1 });
  return (items[0] as { id: string; email: string } | undefined) ?? null;
}

function emailAndPassword(args: string[]): [string, string] {
  if (args.length !== 2)
    throw new Error("missing email and password arguments");
  if (args[0] === "" || !isEmail(args[0]!))
    throw new Error("missing or invalid email address");
  return [args[0]!, args[1]!];
}

function emailOnly(args: string[]): string {
  if (args.length === 0 || args[0] === "" || !isEmail(args[0]!))
    throw new Error("invalid or missing email address");
  return args[0]!;
}

async function upsert(args: string[], app: App) {
  const [email, password] = emailAndPassword(args);
  const existing = await findSuperuser(app, email);
  await failing("failed to upsert superuser account", () =>
    existing
      ? app.records(SUPERUSERS).update(existing.id, { email, password })
      : app.records(SUPERUSERS).create({ email, password }),
  );
  console.log(`Successfully saved superuser "${email}"!`);
}

async function create(args: string[], app: App) {
  const [email, password] = emailAndPassword(args);
  await failing("failed to create new superuser account", () =>
    app.records(SUPERUSERS).create({ email, password }),
  );
  console.log(`Successfully created new superuser "${email}"!`);
}

async function update(args: string[], app: App) {
  const [email, password] = emailAndPassword(args);
  const superuser = await findSuperuser(app, email);
  if (!superuser)
    throw new Error(`superuser with email "${email}" doesn't exist`);
  await failing(`failed to change superuser "${email}" password`, () =>
    app.records(SUPERUSERS).update(superuser.id, { password }),
  );
  console.log(`Successfully changed superuser "${email}" password!`);
}

async function remove(args: string[], app: App) {
  const email = emailOnly(args);
  const superuser = await findSuperuser(app, email);
  if (!superuser) {
    console.log(`superuser "${email}" is missing or already deleted`);
    return;
  }
  await failing(`failed to delete superuser "${email}"`, () =>
    app.records(SUPERUSERS).delete(superuser.id),
  );
  console.log(`Successfully deleted superuser "${email}"!`);
}

async function otp(args: string[], app: App) {
  const email = emailOnly(args);
  const superuser = await findSuperuser(app, email);
  if (!superuser)
    throw new Error(`superuser with email "${email}" doesn't exist`);
  const collection = app.collections.find(SUPERUSERS)!;
  const options = collection.otp as {
    enabled: boolean;
    duration: number;
    length: number;
  };
  if (!options.enabled)
    throw new Error("OTP auth is not enabled for the _superusers collection");
  const pass = generateOtpCode(options.length);
  const created = await failing("failed to create OTP", () =>
    internalRecords(app, "_otps").create({
      collectionRef: collection.id,
      recordRef: superuser.id,
      password: pass,
    }),
  );
  console.log(`Successfully created OTP for superuser "${email}":`);
  console.log(`├─ Id:    ${created.id}`);
  console.log(`├─ Pass:  ${pass}`);
  console.log(`└─ Valid: ${options.duration}s\n`);
}

async function ips(args: string[], app: App) {
  await app.settings.update({ superuserIPs: args });
  if (args.length === 0) {
    console.log("Successfully cleared SuperuserIPs setting!");
    return;
  }
  console.log("Successfully updated SuperuserIPs setting:");
  args.forEach((ip, i) =>
    console.log(`${i === args.length - 1 ? "└─" : "├─"} ${ip}`),
  );
}

const SUBCOMMANDS: Record<string, (args: string[], app: App) => Promise<void>> =
  {
    upsert,
    create,
    update,
    delete: remove,
    otp,
    ips,
  };

export async function superuserCommand(
  args: string[],
  app: App,
): Promise<void> {
  const { positionals } = parseCommandArgs(args, {});
  const [name, ...rest] = positionals;
  const run =
    name !== undefined && Object.hasOwn(SUBCOMMANDS, name)
      ? SUBCOMMANDS[name]
      : undefined;
  if (!run) {
    throw new Error(
      `usage: superuser <${Object.keys(SUBCOMMANDS).join("|")}> [args]`,
    );
  }
  await run(rest, app);
}
