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

app.onRecordCreateRequest("req_items", (e) => {
  const title = String(e.record.get("title"));
  if (title === "skip") return;
  if (title === "fail") throw e.badRequestError("Rejected.");
  if (title === "moved") e.record.set("id", "itemmoved000001");
  e.record.set("title", title.toUpperCase());
  return e.next();
});

app.onRecordUpdateRequest("req_items", (e) => {
  const title = e.record.get("title");
  if (title === "skip") return;
  if (title === "fail") throw e.badRequestError("Rejected.");
  return e.next();
});

app.onRecordUpdateRequest("users", (e) => {
  if (e.record.get("name") === "verify") e.record.set("verified", true);
  return e.next();
});

app.onRecordViewRequest("req_items", (e) =>
  e.record.get("title") === "CUSTOM"
    ? e.json(200, { custom: true, title: e.record.get("title") })
    : e.next(),
);

app.onRecordsListRequest("req_items", (e) => {
  e.result.items = e.records.filter((r) => r.get("title") !== "DROP");
  return e.next();
});

app.onRecordDeleteRequest("req_items", (e) => {
  if (e.record.get("title") === "PROTECTED")
    throw e.forbiddenError("Protected.");
  return e.next();
});

app.onRecordEnrich(["req_items", "req_tags"], async (e) => {
  await e.next();
  e.record.hide("secret");
  e.record.withCustomData(true);
  e.record.set("label", `enriched ${e.record.collection.name}`);
});

app.onCollectionCreateRequest((e) => {
  if (e.collection.name.startsWith("blocked_"))
    throw e.badRequestError("Blocked name.");
  return e.next();
});

app.onCollectionViewRequest((e) =>
  e.collection.name === "req_members"
    ? e.json(200, { wrapped: e.collection })
    : e.next(),
);

app.onCollectionsListRequest((e) => {
  if (e.query.get("nosystem"))
    e.result.items = e.collections.filter((c) => !c.system);
  return e.next();
});

app.onCollectionUpdateRequest((e) => {
  if (e.collection.name === "req_locked") throw e.badRequestError("Locked.");
  return e.next();
});

app.onCollectionDeleteRequest((e) => {
  if (e.collection.name === "req_locked") throw e.forbiddenError("Locked.");
  return e.next();
});

app.onCollectionsImportRequest((e) => {
  if (e.deleteMissing) throw e.badRequestError("No deleteMissing imports.");
  return e.next();
});

app.onBatchRequest((e) => {
  if (e.batch.length > 2) throw e.badRequestError("Too many requests.");
  return e.next();
});

app.onFileDownloadRequest("req_items", (e) => {
  e.servedName = "renamed.txt";
  return e.next();
});

app.onFileTokenRequest("users", (e) => {
  throw e.forbiddenError("No file tokens for users.");
});

process.exitCode = await app.start();
