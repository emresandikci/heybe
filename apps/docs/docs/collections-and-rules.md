# Collections and rules

## Collections

A collection is a table with a schema. There are three types:

| Type   | Use                                                   |
| ------ | ----------------------------------------------------- |
| `base` | Plain records                                         |
| `auth` | Records that can sign in (password, OAuth2, OTP, MFA) |
| `view` | A read-only collection defined by a SQL `SELECT`      |

Create and edit collections in the dashboard: fields, rules and indexes are all on the collection's settings panel. The same operations are available through `heybe.collections` in the [client](/client).

When a collection changes in the dashboard or the API, Heybe writes a migration file to `hb_migrations` (turn this off with `--automigrate=false`). See [Cron and migrations](/cron-and-migrations).

Relations can be expanded in a request. Back-relations use the `<collection>_via_<field>` name, for example `comments_via_post`. See [Queries](/queries).

## API rules

Each collection has five rules: `listRule`, `viewRule`, `createRule`, `updateRule` and `deleteRule`. A rule has three states:

| Value         | Meaning                                            |
| ------------- | -------------------------------------------------- |
| `null`        | Locked. Only superusers can perform the action.    |
| `""` (empty)  | Open. Anyone, signed in or not, can perform it.    |
| An expression | The action is allowed when the expression is true. |

A superuser skips every rule. For view, update and delete, a record that does not match the rule returns 404.

Rules use the same filter syntax as `filter` query strings:

```
@request.auth.id != "" && author = @request.auth.id
```

### Operators

| Operator                                    | Meaning                                                 |
| ------------------------------------------- | ------------------------------------------------------- |
| `=` `!=`                                    | Equal, not equal                                        |
| `>` `>=` `<` `<=`                           | Comparison                                              |
| `~` `!~`                                    | Contains, does not contain (LIKE)                       |
| `?=` `?!=` `?>` `?>=` `?<` `?<=` `?~` `?!~` | Same, true when any item of a multi-value field matches |

Combine conditions with `&&` and `||`, and group them with parentheses.

### Request variables

| Variable               | Value                                                            |
| ---------------------- | ---------------------------------------------------------------- |
| `@request.auth.*`      | The signed-in record, for example `@request.auth.id`             |
| `@request.body.*`      | Fields sent in the request body                                  |
| `@request.query.*`     | Query string parameters                                          |
| `@request.headers.*`   | Request headers (lower case, `_` for `-`)                        |
| `@request.method`      | The HTTP method                                                  |
| `@request.context`     | Where the request came from, for example `default` or `realtime` |
| `@collection.<name>.*` | Join another collection by name                                  |

### Field modifiers

Add a modifier after a field name: `:isset` (was the field sent in the body), `:changed` (does the body change the value), `:length`, `:each` and `:lower`.

```
@request.body.role:isset = false
tags:length > 2
tags:each ~ "news"
title:lower ~ "heybe"
```

### Date macros

`@now`, `@yesterday`, `@tomorrow`, `@second`, `@minute`, `@hour`, `@day`, `@month`, `@weekday`, `@year`, `@todayStart`, `@todayEnd`, `@monthStart`, `@monthEnd`, `@yearStart`, `@yearEnd`. All times are UTC.

```
created >= @todayStart
```

## Examples

Only the owner can read and change a record:

```
listRule:   @request.auth.id != "" && owner = @request.auth.id
viewRule:   @request.auth.id != "" && owner = @request.auth.id
updateRule: owner = @request.auth.id && @request.body.owner:isset = false
```

Public read, no public write: `listRule` and `viewRule` set to `""`, the other three left as `null`.
