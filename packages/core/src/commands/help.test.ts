import { describe, expect, test } from "bun:test";
import { formatCommandHelp, formatRootHelp } from "./help";
import { migrateHelp } from "./migrate";
import { serveHelp } from "./serve";
import { superuserHelp } from "./superuser";
import { typegenHelp } from "./typegen";

const GLOBAL_FLAGS = `Global Flags:
      --automigrate            enable/disable auto migrations (default true)
      --dev                    enable dev mode, aka. printing logs and sql statements to the console
      --dir string             the Heybe data directory (default "./hb_data")
      --hooksDir string        the directory with the user defined hooks and routes
      --migrationsDir string   the directory with the user defined migrations
`;

describe("help", () => {
  test("serve --help matches the cobra layout", () => {
    expect(formatCommandHelp(["serve"], serveHelp))
      .toBe(`Starts the web server (default to 127.0.0.1:8090 if no domain is specified)

Usage:
  heybe serve [domain(s)] [flags]

Flags:
  -h, --help              help for serve
      --http string       TCP address to listen for the HTTP server
                          (if domain args are specified - default to 0.0.0.0:80, otherwise - default to 127.0.0.1:8090)
      --https string      TCP address to listen for the HTTPS server
                          (if domain args are specified - default to 0.0.0.0:443, otherwise - default to empty string, aka. no TLS)
                          The incoming HTTP traffic also will be auto redirected to the HTTPS version
      --origins strings   CORS allowed domain origins list (default [*])

${GLOBAL_FLAGS}`);
  });

  test("superuser --help lists the subcommands", () => {
    const text = formatCommandHelp(["superuser"], superuserHelp);
    expect(text).toContain(`Usage:
  heybe superuser [command]

Available Commands:
  create      Creates a new superuser
  delete      Deletes an existing superuser
  ips         Updates the superuser IPs whitelist setting (the IPs/subnets arguments must be space separated; leave empty to clear the whitelist restriction)
  otp         Creates a new OTP for the specified superuser
  update      Changes the password of a single superuser
  upsert      Creates, or updates if email exists, a single superuser

Flags:
  -h, --help   help for superuser
`);
    expect(text).toEndWith(
      '\nUse "heybe superuser [command] --help" for more information about a command.\n',
    );
  });

  test("superuser upsert --help shows the example", () => {
    const upsert = superuserHelp.commands!.find((c) => c.use === "upsert")!;
    expect(formatCommandHelp(["superuser", "upsert"], upsert))
      .toBe(`Creates, or updates if email exists, a single superuser

Usage:
  heybe superuser upsert [flags]

Examples:
superuser upsert test@example.com 1234567890

Flags:
  -h, --help   help for upsert

${GLOBAL_FLAGS}`);
  });

  test("migrate --help prints the long text", () => {
    const text = formatCommandHelp(["migrate"], migrateHelp);
    expect(text).toStartWith(`Supported arguments are:
- up            - runs all available migrations
- down [number] - reverts the last [number] applied migrations
`);
    expect(text).toContain("- history-sync  - ensures");
    expect(text).toContain("\n\nUsage:\n  heybe migrate [flags]\n");
  });

  test("root help lists commands with -v, --version", () => {
    expect(formatRootHelp([serveHelp, typegenHelp])).toBe(`heybe CLI

Usage:
  heybe [command]

Available Commands:
  serve       Starts the web server (default to 127.0.0.1:8090 if no domain is specified)
  typegen     Generates TypeScript types for the collections

Flags:
      --automigrate            enable/disable auto migrations (default true)
      --dev                    enable dev mode, aka. printing logs and sql statements to the console
      --dir string             the Heybe data directory (default "./hb_data")
  -h, --help                   help for heybe
      --hooksDir string        the directory with the user defined hooks and routes
      --migrationsDir string   the directory with the user defined migrations
  -v, --version                version for heybe

Use "heybe [command] --help" for more information about a command.
`);
  });
});
