// Heybe side of the extension fixtures; contract/extend/pb_hooks/main.pb.js has the same cases for PocketBase.
import {
  ApiError,
  type RequestEvent,
  Route,
  createApp,
  requireAuth,
  requireSuperuserAuth,
  requireSuperuserOrOwnerAuth,
} from "../../src/index";

const app = createApp();

app.use((e) => {
  e.responseHeaders.set("x-contract", "global");
  return e.next();
});

app.get("/hello/{name}", (e) =>
  e.json(200, { message: `Hello ${e.params.name}`, meta: { a: 1, b: 2 } }),
);

class TextRoute extends Route {
  method = "GET";
  path = "/text";
  handle(e: RequestEvent) {
    return e.string(200, "plain text");
  }
}
app.register(TextRoute);

app.get("/page", (e) => e.html(200, "<p>page</p>"));

app.delete("/nothing", (e) => e.noContent(204));

app.get("/go", (e) => e.redirect(302, "/hello/redirected"));

app.get("/fail", (e) => {
  throw e.badRequestError("Custom.", { title: "bad", nested: { x: 1 } });
});

app.get("/throw", () => {
  throw new Error("boom");
});

app
  .group("/members")
  .use(requireAuth("users"))
  .get("/me", (e) =>
    e.json(200, { id: e.auth!.record.id, collection: e.auth!.collection.name }),
  );

app.get("/admin", (e) => e.json(200, { ok: true }), requireSuperuserAuth());

app.get(
  "/owner/{id}",
  (e) => e.json(200, { id: e.params.id }),
  requireSuperuserOrOwnerAuth("id"),
);

app.onRecordCreate("hooked", (e) => {
  const title = String(e.record.get("title"));
  e.record.set("slug", title.toLowerCase().replace(/ /g, "-"));
  return e.next();
});

app.onRecordUpdate("hooked", (e) => {
  if (e.record.get("title") === "block") throw new ApiError(400, "Blocked.");
  return e.next();
});

app.onRecordDelete("hooked", (e) =>
  e.record.get("title") === "keep" ? undefined : e.next(),
);

app.onRecordAfterCreateSuccess("hooked", async (e) => {
  await e.app
    .records("audit")
    .create({ note: `created ${e.record.get("title")}` });
  return e.next();
});

process.exitCode = await app.start();
