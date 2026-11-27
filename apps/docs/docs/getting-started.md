# Getting started

## Install

Download the archive for your platform from [GitHub Releases](https://github.com/emresandikci/heybe/releases) and unzip it. Each release has a `checksums.txt` with the SHA-256 of every archive.

## Start the server

```bash
./heybe serve
```

On the first start Heybe prints a link to create the first superuser. After that:

- Dashboard: http://127.0.0.1:8090/_/
- REST API: http://127.0.0.1:8090/api/

Data goes to `./hb_data` next to where you run the command.

## Create a superuser from the command line

```bash
./heybe superuser upsert admin@example.com 'a-long-password'
```

`superuser` also has `create`, `update`, `delete`, `otp` and `ips`.

## Create a collection and read it

In the dashboard, create a base collection named `posts` with a `title` text field. Then set its list rule to an empty string to let anyone read it (see [Collections and rules](/collections-and-rules)). Read it over HTTP:

```bash
curl http://127.0.0.1:8090/api/collections/posts/records
```

Or with the client (see [Client](/client)):

```ts
import { createClient } from "@heybejs/client";

const heybe = createClient("http://127.0.0.1:8090");
const page = await heybe.records("posts").findMany({ perPage: 20 });
```

## Commands and flags

Run `./heybe --help` for the full list. The commands are `serve`, `superuser`, `migrate`, `import` and `typegen`.

Global flags work on every command:

| Flag                     | Meaning                                                                | Default           |
| ------------------------ | ---------------------------------------------------------------------- | ----------------- |
| `--dir <path>`           | Data directory                                                         | `./hb_data`       |
| `--hooksDir <path>`      | Directory with hooks and routes                                        | `./hb_hooks`      |
| `--migrationsDir <path>` | Directory with migrations                                              | `./hb_migrations` |
| `--automigrate`          | Write a migration file when collections change in the dashboard or API | `true`            |
| `--dev`                  | Print logs and SQL statements to the console, and write types          | off               |

The hooks and migrations directories default to siblings of the data directory.

`serve` has its own flags:

| Flag               | Meaning              | Default                                         |
| ------------------ | -------------------- | ----------------------------------------------- |
| `--http <addr>`    | HTTP listen address  | `127.0.0.1:8090`, or `0.0.0.0:80` with a domain |
| `--https <addr>`   | HTTPS listen address | none, or `0.0.0.0:443` with a domain            |
| `--origins <list>` | Allowed CORS origins | `*`                                             |

## Next

- Run it in a container: [Docker](/docker)
- Put it on a server: [Deploying](/deploying)
