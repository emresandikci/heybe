# @heybe/client

```sh
npm install @heybe/client
```

```ts
import { createClient } from "@heybe/client";
```

## Records

```ts
const posts = heybe.records("posts");

const page = await posts.findMany({
  where: { status: "published", views: { gt: 5 } },
  orderBy: { created: "desc" },
  expand: { author: true },
  page: 1,
  perPage: 20,
});
page.items[0]?.expand?.author?.email;

const post = await posts.findOne("RECORD_ID", { expand: { author: true } });
const first = await posts.findFirst({ where: { slug: "hello" } });
await posts.create({ title: "Hello", cover: new File([bytes], "cover.png") });
await posts.update(post.id, { title: "Renamed", "tags+": "new" });
await posts.delete(post.id);
```

Collection types come from the generated `Collections` interface; an unknown collection name is typed loosely. `findMany` returns `totalItems: -1` with `count: false`. `findFirst` rejects with a 404 `HeybeError` when nothing matches.

Requests are auto-cancelled: a new request with the same key (`METHOD + path`) aborts the pending one. Pass `requestKey: null` per request to opt out, or set `autoCancel: false` on the client.

On a multi-value field (`select` with `maxSelect > 1`, `relation`, `file`), PocketBase's `tags?="x"` (`anyEq`) matches nothing. Use `each` instead: `where: { tags: { each: { anyEq: "x" } } }` (`tags:each?="x"`).
