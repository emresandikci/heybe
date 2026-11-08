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

## Auth

```ts
const heybe = createClient("http://127.0.0.1:8090", {
  authStore: localStorageStore(), // default in browsers; memoryStore() elsewhere
  autoRefreshThreshold: 300,
});
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

Every successful auth call saves the token and record to `heybe.authStore`. `memoryStore()` keeps them in memory; `localStorageStore(key?, storage?)` persists them and follows changes from other tabs.

MFA: when the first factor needs a second one, it rejects with a 401 `HeybeError` whose `response.mfaId` goes to the second factor:

```ts
try {
  await users.withPassword("a@example.com", "secret");
} catch (err) {
  if (!(err instanceof HeybeError) || !err.response.mfaId) throw err;
  const { otpId } = await users.requestOTP("a@example.com");
  await users.withOTP(otpId, code, { mfaId: String(err.response.mfaId) });
}
```

Also available: `withOAuth2Code`, `impersonate(recordId, seconds)` (returns a new client holding the impersonated auth, the caller's store is untouched), `requestVerification`/`confirmVerification`, `requestPasswordReset`/`confirmPasswordReset`, `requestEmailChange`/`confirmEmailChange`.

`autoRefreshThreshold` (seconds): before each request, when the stored token expires within the threshold, the client runs one shared `auth-refresh` and sends the request with the new token. A failed refresh leaves the store as it is. For superusers, `withPassword(identity, password, { autoRefreshThreshold })` also logs in again with the same credentials when the token is invalid or the refresh fails, until the store is cleared or holds another record.
