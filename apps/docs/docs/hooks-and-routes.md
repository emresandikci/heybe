# Hooks and routes

Put TypeScript or JavaScript files in `hb_hooks`, next to `hb_data`. The binary loads them on start, in file name order, with no build step. `--hooksDir` points to another directory.

Each file must export a function as its default export. It receives the app and registers what it needs. Files that end in `.d.ts` or `.test.ts` are skipped. A file that throws, or does not export a function, stops the start with `failed to load hooks <file>`.

## Editor types

The binary provides `@heybejs/core` to these files itself, so nothing needs to be installed to run them. For autocompletion and type checks in your editor, add it as a dev dependency next to `hb_hooks`:

```bash
bun add -d @heybejs/core
```

The binary keeps using its own copy at runtime.

## Classes

```ts
// hb_hooks/posts.ts
import { RecordHooks, Route } from "@heybejs/core";

class PostHooks extends RecordHooks {
  collection = "posts";

  async onCreate(e) {
    e.record.set("slug", slugify(e.record.get("title")));
    return e.next();
  }
}

class HelloRoute extends Route {
  method = "GET";
  path = "/hello/{name}";

  async handle(e) {
    return e.json(200, { message: `Hello ${e.params.name}` });
  }
}

export default (app) => app.register(PostHooks, HelloRoute);
```

`RecordHooks` binds each method you define to the matching hook of one `collection`. The method names drop the `Record` part of the hook name: `onValidate`, `onCreate`, `onCreateExecute`, `onAfterCreateSuccess`, `onAfterCreateError`, and the same for `Update` and `Delete`, plus `onEnrich`, `onListRequest`, `onViewRequest`, `onCreateRequest`, `onUpdateRequest`, `onDeleteRequest`, the auth request hooks (`onAuthRequest`, `onAuthWithPasswordRequest`, `onAuthWithOAuth2Request`, `onAuthRefreshRequest`, `onAuthWithOTPRequest`, and the password reset, verification, email change and OTP request hooks), the mailer hooks (`onMailerPasswordResetSend` and others) and `onFileDownloadRequest` and `onFileTokenRequest`. Set `priority` to order handlers.

`Route` takes `method`, `path`, an optional `middlewares` array and a `handle` method.

## Functions

```ts
// hb_hooks/hello.ts
export default (app) => {
  app.onRecordCreate("posts", async (e) => e.next());
  app.get("/hello/{name}", (e) => e.json(200, { message: "Hello" }));
};
```

Call `e.next()` to continue to the next handler and the default behavior. Not calling it stops the chain.

## Routes and middleware

The app has the router methods `get`, `post`, `put`, `patch`, `delete`, `head`, `options`, `any`, `group` and `use`. Path parameters are written `{name}` and read from `e.params`. A group takes a prefix and can carry middleware:

```ts
import { requireAuth } from "@heybejs/core";

export default (app) => {
  const api = app.group("/api/my").use(requireAuth());
  api.get("/ping", (e) => e.json(200, { ok: true }));
};
```

`requireAuth(...collections)`, `requireSuperuserAuth()` and `requireSuperuserOrOwnerAuth()` are exported from `@heybejs/core`.

## Console commands

```ts
export default (app) => {
  app.command("hello", () => console.log("hello"), {
    description: "Say hello",
  });
};
```

Run it with `heybe hello`.

## Server start

`app.onServe` runs when the server starts and exposes the router, which is where [dashboard extensions](/dashboard-extensions) are registered.

For scheduled work see [Cron and migrations](/cron-and-migrations).
