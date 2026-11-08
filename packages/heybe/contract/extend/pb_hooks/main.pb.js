// PocketBase side of the extension fixtures; contract/extend/heybe.ts has the same cases for Heybe.

routerUse((e) => {
  e.response.header().set("X-Contract", "global");
  return e.next();
});

routerAdd("GET", "/hello/{name}", (e) =>
  e.json(200, {
    message: "Hello " + e.request.pathValue("name"),
    meta: { a: 1, b: 2 },
  }),
);

routerAdd("GET", "/text", (e) => e.string(200, "plain text"));

routerAdd("GET", "/page", (e) => e.html(200, "<p>page</p>"));

routerAdd("DELETE", "/nothing", (e) => e.noContent(204));

routerAdd("GET", "/go", (e) => e.redirect(302, "/hello/redirected"));

routerAdd("GET", "/fail", () => {
  throw new BadRequestError("Custom.", { title: "bad", nested: { x: 1 } });
});

routerAdd("GET", "/throw", () => {
  throw new Error("boom");
});

routerAdd(
  "GET",
  "/members/me",
  (e) => e.json(200, { id: e.auth.id, collection: e.auth.collection().name }),
  $apis.requireAuth("users"),
);

routerAdd(
  "GET",
  "/admin",
  (e) => e.json(200, { ok: true }),
  $apis.requireSuperuserAuth(),
);

routerAdd(
  "GET",
  "/owner/{id}",
  (e) => e.json(200, { id: e.request.pathValue("id") }),
  $apis.requireSuperuserOrOwnerAuth("id"),
);

onRecordCreate((e) => {
  const title = e.record.getString("title");
  e.record.set("slug", title.toLowerCase().replace(/ /g, "-"));
  e.next();
}, "hooked");

onRecordUpdate((e) => {
  if (e.record.getString("title") === "block")
    throw new BadRequestError("Blocked.");
  e.next();
}, "hooked");

onRecordDelete((e) => {
  if (e.record.getString("title") === "keep") return;
  e.next();
}, "hooked");

onRecordAfterCreateSuccess((e) => {
  const audit = new Record(e.app.findCollectionByNameOrId("audit"));
  audit.set("note", "created " + e.record.getString("title"));
  e.app.save(audit);
  e.next();
}, "hooked");
