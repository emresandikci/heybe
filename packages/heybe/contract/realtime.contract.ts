import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  type Snapshot,
  type Target,
  both,
  expectSame,
  normalize,
  startTargets,
} from "./harness";
import { collectionId } from "../src/collections/model";
import { type Frame, type SSE, connect } from "./sse";

type Name = Target["name"];
type Pair = Record<Name, SSE>;

let targets: Awaited<ReturnType<typeof startTargets>>;
const opened: SSE[] = [];
const ids: Record<string, Record<Name, string>> = {};
const tokens: Record<string, Record<Name, string>> = {};
const PASSWORD = "1234567890";

const api = (
  t: Target,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = t.superToken,
) =>
  fetch(`${t.url}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === null ? {} : { authorization: token }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function same(
  fn: (t: Target) => Promise<Response>,
  status: number,
): Promise<[Snapshot, Snapshot]> {
  const pair = await both(fn);
  expect(pair[0].status).toBe(status);
  expectSame(pair[0], pair[1]);
  return pair;
}

async function write(
  key: string | null,
  method: string,
  path: (t: Target) => string,
  body?: (t: Target) => unknown,
  status = 200,
) {
  await same(async (t) => {
    const res = await api(t, method, path(t), body?.(t));
    if (key && res.ok) {
      const { id } = (await res.clone().json()) as { id: string };
      (ids[key] ??= { pocketbase: "", heybe: "" })[t.name] = id;
    }
    return res;
  }, status);
}

const records = (collection: string) =>
  `/api/collections/${collection}/records`;
const create = (key: string | null, collection: string, data: unknown) =>
  write(
    key,
    "POST",
    () => records(collection),
    () => data,
  );
const update = (key: string, collection: string, data: unknown) =>
  write(
    null,
    "PATCH",
    (t) => `${records(collection)}/${ids[key]![t.name]}`,
    () => data,
  );
const remove = (key: string, collection: string) =>
  write(
    null,
    "DELETE",
    (t) => `${records(collection)}/${ids[key]![t.name]}`,
    undefined,
    204,
  );

async function connectBoth(
  headers: Record<string, string> = {},
): Promise<Pair> {
  const [pb, hb] = await Promise.all([
    connect(targets.pb, headers),
    connect(targets.hb, headers),
  ]);
  opened.push(pb, hb);
  return { pocketbase: pb, heybe: hb };
}

// `auth`: a key of `tokens`, "super" for the superuser, none for a guest
const tokenOf = (t: Target, auth?: string) =>
  auth === undefined
    ? null
    : auth === "super"
      ? t.superToken
      : tokens[auth]![t.name];

const subscribe = (
  pair: Pair,
  topics: (t: Target) => string[],
  auth?: string,
  status = 204,
) => same((t) => pair[t.name].subscribe(topics(t), tokenOf(t, auth)), status);

function normalized(sse: SSE, f: Frame) {
  const name = sse.target.name;
  const own = (s: string) => s.replaceAll(sse.clientId, "<clientId>");
  let data: unknown = own(f.data);
  try {
    data = JSON.parse(data as string);
  } catch {}
  return {
    id: own(f.id),
    event: (normalize(name, f.event.split("/")) as string[]).join("/"),
    data: normalize(name, data),
  };
}

// the next `n` frames of both targets, as sets: PB sends them in a random order
async function frames(pair: Pair, n = 1) {
  const read = async (sse: SSE) => {
    const out: ReturnType<typeof normalized>[] = [];
    for (let i = 0; i < n; i++) out.push(normalized(sse, await sse.next()));
    return out.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  };
  const [pb, hb] = await Promise.all([read(pair.pocketbase), read(pair.heybe)]);
  expect(hb).toEqual(pb);
  return pb;
}

const recordOf = (frame: { data: unknown }) =>
  (frame.data as { record: Record<string, unknown> }).record;

beforeAll(async () => {
  targets = await startTargets();
  await write(
    null,
    "POST",
    () => "/api/collections",
    () => ({
      name: "members",
      type: "auth",
      listRule: "",
      viewRule: "id = @request.auth.id",
      fields: [{ name: "name", type: "text" }],
    }),
  );
  await write(
    null,
    "POST",
    () => "/api/collections",
    () => ({
      name: "posts",
      listRule: "",
      viewRule: "public = true",
      fields: [
        { name: "title", type: "text" },
        { name: "public", type: "bool" },
        { name: "note", type: "text", hidden: true },
        {
          name: "author",
          type: "relation",
          collectionId: collectionId("auth", "members"),
          maxSelect: 1,
        },
      ],
    }),
  );
  await write(
    null,
    "POST",
    () => "/api/collections",
    () => ({
      name: "secret",
      fields: [{ name: "title", type: "text" }],
    }),
  );
  await write(
    null,
    "POST",
    () => "/api/collections",
    () => ({
      name: "sentinel",
      listRule: "",
      fields: [{ name: "title", type: "text" }],
    }),
  );
  await write(
    null,
    "POST",
    () => "/api/collections",
    () => ({
      name: "refs",
      fields: [
        {
          name: "post",
          type: "relation",
          collectionId: collectionId("base", "posts"),
          maxSelect: 1,
          required: true,
        },
      ],
    }),
  );
  for (const key of ["alice", "bob"]) {
    await create(key, "members", {
      email: `${key}@example.com`,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      name: key,
    });
    tokens[key] = { pocketbase: "", heybe: "" };
    await same(async (t) => {
      const res = await api(
        t,
        "POST",
        "/api/collections/members/auth-with-password",
        { identity: `${key}@example.com`, password: PASSWORD },
        null,
      );
      tokens[key]![t.name] = (
        (await res.clone().json()) as { token: string }
      ).token;
      return res;
    }, 200);
  }
}, 60_000);

afterEach(() => {
  for (const sse of opened.splice(0)) sse.close();
});

afterAll(() => targets.stop());

describe("connect", () => {
  test("headers and the first frame", async () => {
    const pair = await connectBoth();
    const names = [
      "content-type",
      "cache-control",
      "x-accel-buffering",
      "x-xss-protection",
      "x-content-type-options",
      "x-frame-options",
      "cross-origin-opener-policy",
      "access-control-allow-origin",
    ];
    const view = (sse: SSE) => ({
      status: sse.status,
      headers: Object.fromEntries(names.map((n) => [n, sse.headers.get(n)])),
      raw: sse.raw.replaceAll(sse.clientId, "<clientId>"),
      id: /^[A-Za-z0-9]{40}$/.test(sse.clientId),
    });
    expect(view(pair.heybe)).toEqual(view(pair.pocketbase));
    expect(view(pair.pocketbase).raw).toBe(
      'id:<clientId>\nevent:PB_CONNECT\ndata:{"clientId":"<clientId>"}\n\n',
    );
  });
});

describe("subscribe errors", () => {
  const post = (body: string, status: number) =>
    same(
      (t) =>
        fetch(`${t.url}/api/realtime`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      status,
    );

  test("invalid body", () => post("{", 400));
  test("blank client id", () => post("{}", 400));
  test("non-string client id", () => post('{"clientId":5}', 400));
  test("too long client id", () =>
    post(JSON.stringify({ clientId: "x".repeat(256) }), 400));
  test("too many subscriptions", () =>
    post(
      JSON.stringify({ clientId: "x", subscriptions: Array(1001).fill("a") }),
      400,
    ));
  test("too long subscription", () =>
    post(
      JSON.stringify({ clientId: "x", subscriptions: ["a", "b".repeat(2501)] }),
      400,
    ));
  test("unknown client", () => post('{"clientId":"nope"}', 404));

  test("another IP", async () => {
    const proxy = (headers: string[]) =>
      same(
        (t) => api(t, "PATCH", "/api/settings", { trustedProxy: { headers } }),
        200,
      );
    await proxy(["X-Forwarded-For"]);
    try {
      const pair = await connectBoth({ "x-forwarded-for": "1.1.1.1" });
      await same(
        (t) =>
          fetch(`${t.url}/api/realtime`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-forwarded-for": "2.2.2.2",
            },
            body: JSON.stringify({ clientId: pair[t.name].clientId }),
          }),
        400,
      );
    } finally {
      await proxy([]);
    }
  });

  test("only a guest to auth change is allowed", async () => {
    const pair = await connectBoth();
    await subscribe(pair, () => ["posts/*"]);
    await subscribe(pair, () => ["posts/*"], "alice");
    await subscribe(pair, () => ["posts/*"], undefined, 403);
    await subscribe(pair, () => ["posts/*"], "super", 403);
    await subscribe(pair, () => ["posts/*"], "alice");
  });
});

describe("broadcast", () => {
  test("a guest on posts/* receives create, update and delete in order", async () => {
    const pair = await connectBoth();
    await subscribe(pair, () => ["posts/*"]);
    await create("p1", "posts", { title: "one", note: "hidden" });
    const [created] = await frames(pair);
    expect(created!.event).toBe("posts/*");
    expect(recordOf(created!).note).toBeUndefined();
    await update("p1", "posts", { title: "two" });
    expect((await frames(pair))[0]!.data).toMatchObject({ action: "update" });
    await remove("p1", "posts");
    expect((await frames(pair))[0]!.data).toMatchObject({ action: "delete" });
  });

  test("a guest gets nothing from a superuser-only collection", async () => {
    const pair = await connectBoth();
    await subscribe(pair, () => ["secret/*", "sentinel/*"]);
    await create(null, "secret", { title: "s" });
    await create(null, "sentinel", { title: "after secret" });
    expect((await frames(pair))[0]!.event).toBe("sentinel/*");
  });

  test("a record topic uses the view rule", async () => {
    await create("private", "posts", { title: "private" });
    await create("public", "posts", { title: "public", public: true });
    const pair = await connectBoth();
    await subscribe(pair, (t) => [
      `posts/${ids.private![t.name]}`,
      `posts/${ids.public![t.name]}`,
    ]);
    await update("private", "posts", { title: "private 2" });
    await update("public", "posts", { title: "public 2" });
    const [frame] = await frames(pair);
    expect(recordOf(frame!).title).toBe("public 2");
  });

  test("filter, expand and fields options", async () => {
    const options = (query: object) =>
      `posts/*?options=${encodeURIComponent(JSON.stringify({ query }))}`;
    const pair = await connectBoth();
    await subscribe(
      pair,
      () => [
        options({ filter: "title = 'b'" }),
        options({ filter: "@request.auth.id != ''" }),
        options({ expand: "author" }),
        options({ fields: "id,title" }),
      ],
      "alice",
    );
    await create(null, "posts", { title: "a" });
    await frames(pair, 2);
    await create(null, "posts", { title: "b" });
    await frames(pair, 3);
    await write(
      null,
      "POST",
      () => records("posts"),
      (t) => ({
        title: "c",
        author: ids.alice![t.name],
      }),
    );
    const all = await frames(pair, 2);
    expect(all.some((f) => "expand" in recordOf(f))).toBe(true);
  });

  test("an auth record shows its email to the owner only", async () => {
    const owner = await connectBoth();
    const guest = await connectBoth();
    await subscribe(owner, () => ["members/*"], "alice");
    await subscribe(guest, () => ["members/*"]);
    await update("alice", "members", { name: "alice 2" });
    expect(recordOf((await frames(owner))[0]!).email).toBe("alice@example.com");
    expect(recordOf((await frames(guest))[0]!).email).toBeUndefined();
  });

  test("a superuser sees hidden fields", async () => {
    const pair = await connectBoth();
    await subscribe(pair, () => ["posts/*"], "super");
    await create(null, "posts", { title: "x", note: "hidden" });
    expect(recordOf((await frames(pair))[0]!).note).toBe("hidden");
  });

  test("after a password change the old client is a guest", async () => {
    const pair = await connectBoth();
    await subscribe(
      pair,
      (t) => [`members/${ids.bob![t.name]}`, "sentinel/*"],
      "bob",
    );
    await update("bob", "members", { name: "bob 2" });
    expect(recordOf((await frames(pair))[0]!).email).toBe("bob@example.com");
    await update("bob", "members", {
      password: "0987654321",
      passwordConfirm: "0987654321",
    });
    await create(null, "sentinel", { title: "after password" });
    expect((await frames(pair))[0]!.event).toBe("sentinel/*");
  });

  test("a guest gets no expand of a relation it cannot view", async () => {
    const pair = await connectBoth();
    const expand = encodeURIComponent(
      JSON.stringify({ query: { expand: "author" } }),
    );
    await subscribe(pair, () => [`posts/*?options=${expand}`]);
    await write(
      null,
      "POST",
      () => records("posts"),
      (t) => ({ title: "guest expand", author: ids.alice![t.name] }),
    );
    const [frame] = await frames(pair);
    expect(recordOf(frame!).expand).toEqual({});
  });
});

describe("rollbacks never broadcast", () => {
  test("a batch failing after a create sends no create", async () => {
    const batch = (enabled: boolean) =>
      same(
        (t) =>
          api(t, "PATCH", "/api/settings", {
            batch: { enabled, maxRequests: 50 },
          }),
        200,
      );
    await batch(true);
    try {
      const pair = await connectBoth();
      await subscribe(pair, () => ["posts/*", "sentinel/*"]);
      await same(
        (t) =>
          api(t, "POST", "/api/batch", {
            requests: [
              {
                method: "POST",
                url: records("posts"),
                body: { title: "rolled back" },
              },
              { method: "POST", url: records("nope"), body: {} },
            ],
          }),
        400,
      );
      await create(null, "sentinel", { title: "after batch" });
      expect((await frames(pair))[0]!.event).toBe("sentinel/*");
    } finally {
      await batch(false);
    }
  });

  test("a failed delete sends nothing, the later delete sends one frame", async () => {
    await create("referenced", "posts", { title: "referenced" });
    await write(
      "ref",
      "POST",
      () => records("refs"),
      (t) => ({
        post: ids.referenced![t.name],
      }),
    );
    const pair = await connectBoth();
    await subscribe(pair, () => ["posts/*", "sentinel/*"]);
    await write(
      null,
      "DELETE",
      (t) => `${records("posts")}/${ids.referenced![t.name]}`,
      undefined,
      400,
    );
    await create(null, "sentinel", { title: "after failed delete" });
    expect((await frames(pair))[0]!.event).toBe("sentinel/*");
    await remove("ref", "refs");
    await remove("referenced", "posts");
    expect((await frames(pair))[0]!.data).toMatchObject({ action: "delete" });
    await create(null, "sentinel", { title: "after delete" });
    expect((await frames(pair))[0]!.event).toBe("sentinel/*");
  });
});
