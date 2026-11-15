import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type Mock,
  spyOn,
  test,
} from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App } from "../../app";
import { newAuthToken } from "../../auth/tokens";
import * as mime from "../../files/mime";
import { RecordServiceImpl } from "../../records/service";
import { toApiError } from "../errors";
import { loadAuth } from "../middlewares";
import { createEvent } from "../router";
import { createRouter } from "../server";
import { internalRecords } from "../../records/internal";
import { cheapPassword, testApp } from "../../test-app";

let app: App;
let dir: string;
let time = Date.parse("2026-01-01T00:00:00Z");
// milliseconds the clock moves on each read
let step = 0;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "heybe-batch-"));
  step = 0;
  app = testApp({ dir, now: () => new Date((time += step)) });
  await app.settings.update({
    batch: { enabled: true, maxRequests: 50, timeout: 3 },
  });
  await app.collections.save({
    name: "notes",
    listRule: "",
    viewRule: "",
    createRule: "",
    fields: [
      { name: "title", type: "text", required: true },
      { name: "file", type: "file", maxSelect: 1 },
    ],
  } as any);
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
  app.close();
  rmSync(dir, { recursive: true, force: true });
});

const create = (title: string) => ({
  method: "POST",
  url: "/api/collections/notes/records",
  body: { title },
});

function form(requests: unknown[], files: Record<string, string>) {
  const data = new FormData();
  data.append("@jsonPayload", JSON.stringify({ requests }));
  for (const [key, text] of Object.entries(files))
    data.append(key, new File([text], "note.txt"));
  return data;
}

let spies: Mock<(...args: any[]) => any>[] = [];
const spy = <T extends object>(target: T, name: keyof T & string) => {
  const s = spyOn(target, name as any) as Mock<(...args: any[]) => any>;
  spies.push(s);
  return s;
};
const passwordSpies = () =>
  (["hash", "hashSync", "verify", "verifySync"] as const).map((n) =>
    spy(Bun.password, n),
  );

async function call(
  method: string,
  path: string,
  body: FormData | Record<string, unknown>,
  token?: string,
  signal?: AbortSignal,
) {
  const json = !(body instanceof FormData);
  const req = new Request(`http://x${path}`, {
    method,
    signal,
    headers: {
      ...(json ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: token } : {}),
    },
    body: json ? JSON.stringify(body) : body,
  });
  const found = createRouter().build().match(method, path)!;
  const e = createEvent(app, req, found.params);
  e.auth = loadAuth(app, req);
  try {
    const res = await found.run(e);
    return { status: res.status, body: (await res.json()) as any };
  } catch (err) {
    const { status, message, data } = toApiError(err);
    return { status, body: { message, data } as any };
  }
}

const batch = (
  body: FormData | Record<string, unknown>,
  token?: string,
  signal?: AbortSignal,
) => call("POST", "/api/batch", body, token, signal);

async function addMember() {
  await app.collections.save({
    name: "members",
    type: "auth",
    updateRule: "id = @request.auth.id",
    fields: [{ name: "name", type: "text" }, cheapPassword],
  } as any);
  const records = internalRecords(app, "members");
  return records
    .create({
      id: "member000000001",
      email: "m@example.com",
      password: "password1",
    })
    .then(() => {
      const c = app.collections.find("members")!;
      return newAuthToken(app, c, records.findRaw("member000000001"));
    });
}

const changePassword = (oldPassword: string, password: string) => ({
  method: "PATCH",
  url: "/api/collections/members/records/member000000001",
  body: { oldPassword, password, passwordConfirm: password },
});

const storedHash = () =>
  (internalRecords(app, "members").findRaw("member000000001").password as any)
    .hash;

function stored(): string[] {
  const root = join(dir, "storage");
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name);
}

const titles = () =>
  internalRecords(app, "notes")
    .query({})
    .items.map((r) => r.title);

describe("batch transaction", () => {
  test("writes every request and keeps the uploads", async () => {
    const res = await batch(
      form([create("a"), create("b")], { "requests.0.file": "x" }),
    );
    expect(res.status).toBe(200);
    expect(titles().sort()).toEqual(["a", "b"]);
    expect(stored()).toEqual([res.body[0].body.file]);
  });

  test("a failed request rolls back every write and deletes every upload", async () => {
    const res = await batch(
      form([create("a"), create("b"), create("")], {
        "requests.0.file": "x",
        "requests[1].file": "y",
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.data.requests[2].response.data.title.code).toBe(
      "validation_required",
    );
    expect(titles()).toEqual([]);
    expect(stored()).toEqual([]);
  });

  test("a batch over its timeout is rolled back with its uploads", async () => {
    step = 2000;
    const res = await batch(
      form([create("a"), create("b")], { "requests.0.file": "x" }),
    );
    expect(res).toEqual({
      status: 400,
      body: { message: "Batch transaction failed.", data: {} },
    });
    step = 0;
    expect(titles()).toEqual([]);
    expect(stored()).toEqual([]);
  });
});

describe("batch interruption", () => {
  test("client abort mid-batch rolls back", async () => {
    const controller = new AbortController();
    const original = RecordServiceImpl.prototype.savePrepared;
    spy(RecordServiceImpl.prototype, "savePrepared").mockImplementation(
      function (this: RecordServiceImpl<any>, ...args: [any, any, any]) {
        controller.abort();
        return original.apply(this, args);
      },
    );
    const res = await batch(
      form([create("a"), create("b")], { "requests.0.file": "x" }),
      undefined,
      controller.signal,
    );
    expect(res).toEqual({
      status: 400,
      body: { message: "Batch transaction failed.", data: {} },
    });
    expect(titles()).toEqual([]);
    expect(stored()).toEqual([]);
  });
});

const addItems = () =>
  app.collections.save({
    name: "items",
    createRule: "",
    updateRule: "",
    viewRule: "",
    fields: [
      { name: "title", type: "text" },
      { name: "file", type: "file", maxSelect: 1 },
    ],
  } as any);

const createItem = {
  method: "POST",
  url: "/api/collections/items/records",
  body: { id: "item00000000001", title: "a" },
};
const updateItem = {
  method: "PATCH",
  url: "/api/collections/items/records/item00000000001",
  body: { title: "b" },
};
const itemIds = () =>
  internalRecords(app, "items")
    .query({})
    .items.map((r) => r.id);

describe("requests prepared inside the transaction", () => {
  test("a client abort while one prepares writes nothing", async () => {
    await addItems();
    const controller = new AbortController();
    const original = RecordServiceImpl.prototype.prepare;
    let calls = 0;
    spy(RecordServiceImpl.prototype, "prepare").mockImplementation(function (
      this: RecordServiceImpl<any>,
      ...args: [any, any]
    ) {
      if (++calls === 2) controller.abort();
      return original.apply(this, args);
    });
    const save = spy(RecordServiceImpl.prototype, "savePrepared");
    const res = await batch(
      { requests: [createItem, updateItem] },
      undefined,
      controller.signal,
    );
    expect(res).toEqual({
      status: 400,
      body: { message: "Batch transaction failed.", data: {} },
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(itemIds()).toEqual([]);
  });

  test("their uploads are deleted when a later request fails", async () => {
    await addItems();
    const res = await batch(
      form([createItem, updateItem, create("")], { "requests.1.file": "x" }),
    );
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.data.requests)).toEqual(["2"]);
    expect(itemIds()).toEqual([]);
    expect(stored()).toEqual([]);
  });
});

describe("batch preparation", () => {
  test("each item is prepared once", async () => {
    await addItems();
    const prepare = spy(RecordServiceImpl.prototype, "prepare");
    const res = await batch({ requests: [createItem, updateItem] });
    expect(res.status).toBe(200);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(internalRecords(app, "items").findRaw("item00000000001").title).toBe(
      "b",
    );
  });

  test("stops at the first request whose rules fail: a guest makes no bcrypt calls", async () => {
    await addMember();
    const calls = passwordSpies();
    const res = await batch({
      requests: Array.from({ length: 50 }, () =>
        changePassword("password1", "password2"),
      ),
    });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.data.requests)).toEqual(["0"]);
    expect(res.body.data.requests[0].response.status).toBe(404);
    for (const c of calls) expect(c).not.toHaveBeenCalled();
  });

  test("an over-limit multipart batch is rejected before its files are read", async () => {
    await app.settings.update({ batch: { maxRequests: 2 } });
    const sniff = spy(mime, "sniffMime");
    const res = await batch(
      form([create("a"), create("b"), create("c")], {
        "requests.0.file": "x",
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.data.requests.code).toBe("validation_length_too_long");
    expect(sniff).not.toHaveBeenCalled();
  });

  test("two password changes of one record check each old password asynchronously", async () => {
    const token = await addMember();
    const calls = passwordSpies();
    const res = await batch(
      {
        requests: [
          changePassword("password1", "password2"),
          changePassword("password2", "password3"),
        ],
      },
      token,
    );
    expect(res.status).toBe(200);
    expect(calls[1]).not.toHaveBeenCalled();
    expect(calls[3]).not.toHaveBeenCalled();
    expect(await Bun.password.verify("password3", storedHash())).toBe(true);
  });

  test("a wrong old password after an earlier change in the batch fails", async () => {
    const token = await addMember();
    const res = await batch(
      {
        requests: [
          changePassword("password1", "password2"),
          changePassword("password1", "password3"),
        ],
      },
      token,
    );
    expect(res.status).toBe(400);
    expect(res.body.data.requests[1].response.data.oldPassword.code).toBe(
      "validation_invalid_old_password",
    );
    expect(await Bun.password.verify("password1", storedHash())).toBe(true);
  });
});

describe("update route old password", () => {
  test("is not verified when the password does not change", async () => {
    const token = await addMember();
    const verify = spy(Bun.password, "verify");
    const res = await call(
      "PATCH",
      "/api/collections/members/records/member000000001",
      { oldPassword: "wrong", name: "x" },
      token,
    );
    // PB still requires the new password, but there is nothing to check the old one for
    expect(res.status).toBe(400);
    expect(res.body.data.password.code).toBe("validation_required");
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("batch request hooks", () => {
  test("later requests run inside the earlier request hooks", async () => {
    const log: string[] = [];
    app.onRecordCreateRequest("notes", async (e) => {
      const title = e.record.get("title");
      log.push(`before ${title}`);
      try {
        await e.next();
        log.push(`after ${title}`);
      } catch (err) {
        log.push(`${title} saw ${toApiError(err).status}`);
        throw err;
      }
    });
    const ok = await batch({ requests: [create("a"), create("b")] });
    expect(ok.body.map((r: any) => r.body.title)).toEqual(["a", "b"]);
    expect(log).toEqual(["before a", "before b", "after b", "after a"]);

    log.length = 0;
    const failed = await batch({ requests: [create("c"), create("")] });
    expect(Object.keys(failed.body.data.requests)).toEqual(["1"]);
    expect(log).toEqual(["before c", "before ", " saw 400", "c saw 400"]);
    expect(titles()).toEqual(["a", "b"]);
  });
});

describe("batch edges", () => {
  test("a failed upload answers the route's 400, not a 500", async () => {
    spy(app.files, "write").mockRejectedValue(new Error("disk full"));
    const res = await batch(
      form([create("a"), create("b")], { "requests.1.file": "x" }),
    );
    expect(res.body.data.requests).toEqual({
      "1": {
        code: "batch_request_failed",
        message: "Batch request failed.",
        response: {
          data: {},
          message: "Failed to create record.",
          status: 400,
        },
      },
    });
  });

  test("a failed upload of an upsert reports update when an earlier request created the id", async () => {
    await app.collections.save({
      ...app.collections.find("notes")!,
      updateRule: "",
    });
    spy(app.files, "write").mockRejectedValue(new Error("disk full"));
    const id = "note00000000001";
    const res = await batch(
      form(
        [
          { ...create("a"), body: { id, title: "a" } },
          {
            method: "PUT",
            url: "/api/collections/notes/records",
            body: { id, title: "b" },
          },
        ],
        { "requests.1.file": "x" },
      ),
    );
    expect(res.body.data.requests[1].response).toEqual({
      data: {},
      message: "Failed to update record.",
      status: 400,
    });
  });

  test("a rule failing after an earlier write wins over a prepare error", async () => {
    const token = await addMember();
    await app.collections.save({
      ...app.collections.find("members")!,
      updateRule: 'id = @request.auth.id && name != "locked"',
    });
    const original = RecordServiceImpl.prototype.prepare;
    let calls = 0;
    spy(RecordServiceImpl.prototype, "prepare").mockImplementation(function (
      this: RecordServiceImpl<any>,
      ...args: [any, any]
    ) {
      if (++calls === 2) return Promise.reject(new Error("disk full"));
      return original.apply(this, args);
    });
    const url = "/api/collections/members/records/member000000001";
    const res = await batch(
      {
        requests: [
          { method: "PATCH", url, body: { name: "locked" } },
          { method: "PATCH", url, body: { name: "b" } },
        ],
      },
      token,
    );
    expect(res.body.data.requests[1].response.status).toBe(404);
  });

  test("a URL fragment is not part of the query values", async () => {
    const res = await batch({
      requests: [
        {
          method: "POST",
          url: "/api/collections/notes/records?fields=id,title#frag",
          body: { title: "f" },
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body[0].body)).toEqual(["id", "title"]);
  });
});
