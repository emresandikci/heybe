# Client

```sh
npm install @heybejs/client @heybejs/query
```

`@heybejs/query` is a peer dependency: the generated collection types augment it, so the app and the client must share one copy. The client runs in browsers, Bun and Node.

## Types

`heybe typegen` writes `hb-env.d.ts` (`--out` sets another path). `heybe serve --dev` rewrites it when collections change. Keep the file inside your tsconfig `include`, or reference it once with `/// <reference path="./hb-env.d.ts" />`.

```ts
import { createClient, type Collections, type Where } from "@heybejs/client";

const heybe = createClient("http://127.0.0.1:8090");
const where: Where<Collections["posts"]> = { status: "published" };
const page = await heybe.records("posts").findMany({ where });
```

`Where`, `OrderBy`, `Expand`, `ListResult`, `Relation`, `WithExpand`, `Collections` and `CollectionName` are re-exported from `@heybejs/client`.

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

`findFirst` rejects with a 404 `HeybeError` when nothing matches. Query arguments are covered in [Queries](/queries).

Requests are auto-cancelled: a new request with the same key (`METHOD + path`) aborts the pending one. Pass `requestKey: null` per request to opt out, or set `autoCancel: false` on the client.

## Auth

```ts
const users = heybe.auth("users");

await users.methods();
await users.withPassword("a@example.com", "secret", { expand: { team: true } });
const { otpId } = await users.requestOTP("a@example.com");
await users.withOTP(otpId, "123456");
await users.refresh();

heybe.authStore.token;
heybe.authStore.record;
heybe.authStore.onChange((token, record) => {});
heybe.authStore.clear();
```

Every successful auth call saves the token and record to `heybe.authStore`. In browsers the default store is `localStorageStore()`, which persists them and follows changes from other tabs. Elsewhere it is `memoryStore()`. Set one with the `authStore` option of `createClient`.

`autoRefreshThreshold` (seconds, in `createClient` options): before each request, when the stored token expires within the threshold, the client runs one shared `auth-refresh` and sends the request with the new token. For superusers, `withPassword(identity, password, { autoRefreshThreshold })` also logs in again with the same credentials when the token is invalid or the refresh fails.

### MFA

When the first factor needs a second one, the call rejects with a 401 `HeybeError` whose `response.mfaId` goes to the second factor:

```ts
try {
  await users.withPassword("a@example.com", "secret");
} catch (err) {
  if (!(err instanceof HeybeError) || !err.response.mfaId) throw err;
  const { otpId } = await users.requestOTP("a@example.com");
  await users.withOTP(otpId, code, { mfaId: String(err.response.mfaId) });
}
```

Also available: `withOAuth2Code`, `impersonate(recordId, seconds)` (returns a new client holding the impersonated auth, your store is untouched), `requestVerification` and `confirmVerification`, `requestPasswordReset` and `confirmPasswordReset`, `requestEmailChange` and `confirmEmailChange`.

### OAuth2

```ts
// browser: opens a centered popup and waits for the provider redirect
await heybe.auth("users").withOAuth2({ provider: "google" });

// Bun, Node or a custom window: open the URL yourself
await heybe.auth("users").withOAuth2({
  provider: "github",
  scopes: ["read:user", "user:email"],
  createData: { name: "New user" },
  urlCallback: (url) => openInBrowser(url),
  signal: AbortSignal.timeout(120_000),
});
```

`withOAuth2` reads the provider from `methods()`, opens a [realtime](/realtime) connection, subscribes to `@oauth2`, and sends the provider's auth URL to the popup or `urlCallback`. The redirect goes to the server's `/api/oauth2-redirect`. Outside a browser, `urlCallback` is required. A state mismatch, a provider error, a lost connection or an aborted `signal` rejects with a `HeybeError`, and every outcome closes the popup and the connection.

## Batch

```ts
const batch = heybe.batch();
batch
  .records("posts")
  .create({ title: "a", cover: new File([bytes], "c.png") });
batch
  .records("posts")
  .update("RECORD_ID", { title: "b" }, { expand: { author: true } });
batch.records("posts").upsert({ id: "RECORD_ID", title: "c" });
batch.records("posts").delete("RECORD_ID");
const results = await batch.send(); // [{ status, body }, ...]
```

A batch is one multipart request to `POST /api/batch`, so batch must be enabled in the settings.

Realtime and files are covered in [Realtime](/realtime) and [Files](/files).

## Superuser services

These need a superuser token (`heybe.auth("_superusers").withPassword(...)`).

```ts
await heybe.collections.create({ name: "posts", type: "base", fields: [] });
await heybe.collections.findMany({ where: { name: { like: "post" } } });
await heybe.collections.update("posts", { listRule: "" });
await heybe.collections.import(collections, true); // deleteMissing
await heybe.collections.truncate("posts");
await heybe.collections.delete("posts");
await heybe.collections.scaffolds();

await heybe.settings.get();
await heybe.settings.update({ meta: { appName: "Acme" } });
await heybe.settings.testEmail("users", "a@b.c", "verification");
await heybe.settings.testS3("storage"); // or "backups"

await heybe.crons.list();
await heybe.crons.run("__hbDBOptimize__");
await heybe.health.check();
```

### Logs

```ts
const { items } = await heybe.logs.findMany({
  where: { "data.status": { gte: 400 } },
  orderBy: { created: "desc" },
  perPage: 50,
});
await heybe.logs.findOne(items[0].id);
await heybe.logs.stats({ where: { level: { gte: 4 } } }); // hourly counts
await heybe.logs.truncate();
```

### Backups

```ts
await heybe.backups.create("before-upgrade.zip"); // name is optional
await heybe.backups.list();
await heybe.backups.upload(file);
const token = await heybe.files.token();
const url = heybe.backups.downloadURL(token, "before-upgrade.zip");
await heybe.backups.restore("before-upgrade.zip"); // the server restarts
await heybe.backups.delete("before-upgrade.zip");
```

### SQL

```ts
const { columns, rows, affectedRows } = await heybe.sql.run(
  "SELECT id, email FROM users",
);
```
