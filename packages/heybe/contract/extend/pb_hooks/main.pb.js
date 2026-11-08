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

onRecordCreateRequest((e) => {
  const title = e.record.getString("title");
  if (title === "skip") return;
  if (title === "fail") throw new BadRequestError("Rejected.");
  if (title === "moved") e.record.set("id", "itemmoved000001");
  e.record.set("title", title.toUpperCase());
  e.next();
}, "req_items");

onRecordUpdateRequest((e) => {
  const title = e.record.getString("title");
  if (title === "skip") return;
  if (title === "fail") throw new BadRequestError("Rejected.");
  e.next();
}, "req_items");

onRecordUpdateRequest((e) => {
  if (e.record.getString("name") === "verify") e.record.set("verified", true);
  e.next();
}, "users");

onRecordViewRequest((e) => {
  if (e.record.getString("title") === "CUSTOM")
    return e.json(200, { custom: true, title: e.record.getString("title") });
  e.next();
}, "req_items");

onRecordsListRequest((e) => {
  e.result.items = e.records.filter((r) => r.getString("title") !== "DROP");
  e.next();
}, "req_items");

onRecordDeleteRequest((e) => {
  if (e.record.getString("title") === "PROTECTED")
    throw new ForbiddenError("Protected.");
  e.next();
}, "req_items");

onRecordEnrich(
  (e) => {
    e.next();
    e.record.hide("secret");
    e.record.withCustomData(true);
    e.record.set("label", "enriched " + e.record.collection().name);
  },
  "req_items",
  "req_tags",
);

onCollectionCreateRequest((e) => {
  if (e.collection.name.startsWith("blocked_"))
    throw new BadRequestError("Blocked name.");
  e.next();
});

onCollectionViewRequest((e) => {
  if (e.collection.name === "req_members")
    return e.json(200, { wrapped: e.collection });
  e.next();
});

onCollectionsListRequest((e) => {
  if (e.requestInfo().query["nosystem"])
    e.result.items = e.collections.filter((c) => !c.system);
  e.next();
});

onCollectionUpdateRequest((e) => {
  if (e.collection.name === "req_locked") throw new BadRequestError("Locked.");
  e.next();
});

onCollectionDeleteRequest((e) => {
  if (e.collection.name === "req_locked") throw new ForbiddenError("Locked.");
  e.next();
});

onCollectionsImportRequest((e) => {
  if (e.deleteMissing) throw new BadRequestError("No deleteMissing imports.");
  e.next();
});

onBatchRequest((e) => {
  if (e.batch.length > 2) throw new BadRequestError("Too many requests.");
  e.next();
});

onFileDownloadRequest((e) => {
  e.servedName = "renamed.txt";
  e.next();
}, "req_items");

onFileTokenRequest((e) => {
  throw new ForbiddenError("No file tokens for users.");
}, "users");

onRecordAuthRequest((e) => {
  e.meta = { custom: "yes" };
  e.next();
}, "users");

onRecordAuthWithPasswordRequest((e) => {
  if (e.identity === "blocked@example.com")
    throw new BadRequestError("Blocked identity.");
  e.next();
}, "users");

onRecordRequestVerificationRequest((e) => {
  if (e.record.email() === "noverify@example.com")
    throw new BadRequestError("No verification.");
  e.next();
}, "users");

onMailerRecordVerificationSend((e) => {
  e.message.subject = "Hooked " + e.record.email();
  e.next();
}, "users");

onMailerSend((e) => {
  if (e.message.to[0].address === "nomail@example.com") return;
  e.next();
});

onSettingsUpdateRequest((e) => {
  if (e.newSettings.meta.appName === "forbidden")
    throw new BadRequestError("Forbidden app name.");
  e.next();
});

onSettingsListRequest((e) => {
  e.settings.meta.senderAddress = "***";
  e.next();
});
