# Queries

`@heybejs/query` turns plain objects into the filter, sort and expand strings the API takes. The client, and server code that calls `app.records(...)`, use the same objects.

```ts
const posts = await heybe.records("posts").findMany({
  where: {
    status: form.status,
    comments: { gt: 50 },
    OR: [{ title: { like: form.search } }, { tags: { anyLike: form.tag } }],
  },
  orderBy: { created: "desc" },
  expand: { author: true },
  page: 1,
  perPage: 30,
});
```

## Arguments

| Argument  | Meaning                                                                          |
| --------- | -------------------------------------------------------------------------------- |
| `where`   | Conditions (below)                                                               |
| `orderBy` | `{ field: "asc" \| "desc" }`, or an array of those for several sort keys         |
| `expand`  | Relations to load, nested: `{ author: true, comments_via_post: { user: true } }` |
| `page`    | Page number                                                                      |
| `perPage` | Items per page                                                                   |
| `count`   | Pass `false` to skip counting; `totalItems` is then `-1`                         |

## Conditions

A plain value means equal: `{ status: "published" }`. Several keys are joined with AND. Use `AND` and `OR` arrays to group.

Conditions with an `undefined` value are skipped, so form inputs can be passed directly. `null` values, empty `AND`/`OR` arrays and non-finite numbers produce no condition either.

| Operator                                                                         | Filter                                                    |
| -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `eq`, `neq`                                                                      | `=`, `!=`                                                 |
| `gt`, `gte`, `lt`, `lte`                                                         | `>`, `>=`, `<`, `<=`                                      |
| `like`, `notLike`                                                                | `~`, `!~`                                                 |
| `anyEq`, `anyNeq`, `anyGt`, `anyGte`, `anyLt`, `anyLte`, `anyLike`, `anyNotLike` | the `?` versions, for multi-value fields                  |
| `insensitive: true`                                                              | compares in lower case (`:lower`)                         |
| `length`                                                                         | `:length`, takes operators: `tags: { length: { gt: 2 } }` |
| `each`                                                                           | `:each`, takes operators: `tags: { each: { like: "x" } }` |
| `empty: true \| false`                                                           | `= ""` or `!= ""`                                         |

Dates are sent as `YYYY-MM-DD HH:MM:SS.sssZ`. A string that starts with `@` and is a date macro, such as `"@todayStart"`, is passed through as the macro (see [Collections and rules](/collections-and-rules)).

On a multi-value field (`select` with `maxSelect > 1`, `relation`, `file`), `anyEq` on the field itself matches nothing. Use `each`:

```ts
where: {
  tags: {
    each: {
      anyEq: "x";
    }
  }
}
```

## Raw filters

For user-typed input, `findMany` and `findFirst` also take raw `filter` and `sort` strings in the filter syntax. They are joined with the generated ones: `(where) && (filter)` and `orderBy,sort`.

```ts
await heybe
  .records("posts")
  .findMany({ filter: 'title ~ "news"', sort: "-created" });
```

## Types

`heybe typegen` writes `hb-env.d.ts` with a type for every collection, and `where`, `orderBy` and `expand` are checked against it. See [Client](/client).
