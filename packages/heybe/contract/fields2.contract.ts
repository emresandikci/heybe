import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Snapshot,
  type Target,
  both,
  expectSame,
  startTargets,
} from "./harness";

let targets: Awaited<ReturnType<typeof startTargets>>;

const api = (t: Target, method: string, path: string, body?: unknown) =>
  fetch(`${t.url}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      authorization: t.superToken,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function same(
  fn: (t: Target) => Promise<Response>,
  status = 200,
): Promise<Snapshot> {
  const [pb, hb] = await both(fn);
  expect(pb.status).toBe(status);
  expectSame(pb, hb);
  return pb;
}

const records = (rest = "", collection = "places") =>
  `/api/collections/${collection}/records${rest}`;

beforeAll(async () => {
  targets = await startTargets();
  for (const t of [targets.pb, targets.hb]) {
    const res = await api(t, "POST", "/api/collections", {
      name: "places",
      listRule: "",
      viewRule: "",
      createRule: "",
      updateRule: "",
      fields: [
        { name: "title", type: "text" },
        { name: "body", type: "editor", required: true, maxSize: 20 },
        { name: "html", type: "editor", convertURLs: true },
        { name: "address", type: "geoPoint" },
        { name: "origin", type: "geoPoint", required: true },
      ],
    });
    if (!res.ok) throw new Error(`${t.name}: ${await res.text()}`);
    const spots = await api(t, "POST", "/api/collections", {
      name: "spots",
      listRule: "",
      viewRule: "",
      updateRule: "",
      fields: [
        { name: "title", type: "text" },
        { name: "address", type: "geoPoint" },
        { name: "body", type: "editor" },
      ],
    });
    if (!spots.ok) throw new Error(`${t.name}: ${await spots.text()}`);
  }
});

afterAll(async () => {
  await targets.stop();
});

const create = (body: unknown) => (t: Target) =>
  api(t, "POST", records(), body);

describe("collection settings", () => {
  test("fields are returned with their defaults", () =>
    same((t) => api(t, "GET", "/api/collections/places")));

  test("invalid editor maxSize", () =>
    same(
      (t) =>
        api(t, "POST", "/api/collections", {
          name: "bad_editor",
          fields: [{ name: "a", type: "editor", maxSize: -1 }],
        }),
      400,
    ));

  test("editor maxSize above the safe json int", () =>
    same(
      (t) =>
        api(t, "POST", "/api/collections", {
          name: "bad_editor",
          fields: [{ name: "a", type: "editor", maxSize: 2 ** 53 }],
        }),
      400,
    ));

  test("invalid geoPoint help", () =>
    same(
      (t) =>
        api(t, "POST", "/api/collections", {
          name: "bad_geo",
          fields: [{ name: "a", type: "geoPoint", help: "x".repeat(301) }],
        }),
      400,
    ));
});

describe("create", () => {
  test("defaults for omitted values", () =>
    same(create({ title: "a", body: "x", origin: { lon: 1, lat: 1 } })));

  test("valid values", () =>
    same(
      create({
        title: "b",
        body: "<p>hi</p>",
        html: "<b>x</b>",
        address: { lon: 23.32, lat: 42.69 },
        origin: { lon: -10, lat: 20 },
      }),
    ));

  test("geoPoint from a json string", () =>
    same(
      create({
        title: "c",
        body: "x",
        address: '{"lon": 5, "lat": 6}',
        origin: { lon: 1, lat: 1 },
      }),
    ));

  test("geoPoint null and empty object are the zero value", () =>
    same(
      create({
        title: "d",
        body: "x",
        address: null,
        origin: { lon: 0, lat: 1 },
      }),
    ));

  test("geoPoint extra keys are ignored", () =>
    same(
      create({
        title: "e",
        body: "x",
        address: { lon: 1, lat: 2, alt: 3 },
        origin: { lon: 1, lat: 1 },
      }),
    ));

  test("editor casts numbers and booleans to text", () =>
    same(create({ title: "f", body: 123.5, origin: { lon: 1, lat: 1 } })));

  test.each([
    ["required editor blank", { body: "", origin: { lon: 1, lat: 1 } }],
    ["required geoPoint zero", { body: "x", origin: { lon: 0, lat: 0 } }],
    ["required geoPoint missing", { body: "x" }],
    [
      "editor above maxSize",
      { body: "x".repeat(21), origin: { lon: 1, lat: 1 } },
    ],
    ["latitude below range", { body: "x", origin: { lon: 1, lat: -90.1 } }],
    ["latitude above range", { body: "x", origin: { lon: 1, lat: 90.1 } }],
    ["longitude below range", { body: "x", origin: { lon: -180.1, lat: 1 } }],
    ["longitude above range", { body: "x", origin: { lon: 180.1, lat: 1 } }],
    [
      "optional geoPoint out of range",
      { body: "x", origin: { lon: 1, lat: 1 }, address: { lon: 1, lat: 100 } },
    ],
  ])("invalid: %s", (_, body) => same(create({ title: "bad", ...body }), 400));

  test.each([
    ["string", "nope"],
    ["number", 5],
    ["array", [1, 2]],
    ["numeric string lon", { lon: "10" }],
    ["null lon", { lon: null, lat: 4 }],
    ["wrong key case", { Lon: 3, LAT: 4 }],
    ["boolean", true],
  ])("geoPoint malformed value: %s", (_, address) =>
    same(
      create({ title: "m", body: "x", address, origin: { lon: 1, lat: 1 } }),
    ),
  );

  test.each([
    ["object", { a: 1 }],
    ["array", [1]],
    ["null", null],
  ])("editor non-scalar value: %s", (_, body) =>
    same(create({ title: "o", body, origin: { lon: 1, lat: 1 } }), 400),
  );

  test("multipart geoPoint json string", () =>
    same((t) => {
      const form = new FormData();
      form.set("title", "form");
      form.set("body", "x");
      form.set("origin", '{"lon": 7, "lat": 8}');
      return fetch(`${t.url}${records()}`, {
        method: "POST",
        headers: { authorization: t.superToken },
        body: form,
      });
    }));
});

describe("update and lists", () => {
  const ids: Record<Target["name"], string> = { pocketbase: "", heybe: "" };

  beforeAll(async () => {
    for (const t of [targets.pb, targets.hb]) {
      for (const [title, lon, lat] of [
        ["sofia", 23.32, 42.69],
        ["plovdiv", 24.75, 42.15],
        ["athens", 23.73, 37.98],
        ["lima", -77.04, -12.05],
      ] as const) {
        const res = await api(t, "POST", records("", "spots"), {
          title,
          body: title,
          address: { lon, lat },
        });
        const json = (await res.json()) as { id: string };
        if (title === "sofia") ids[t.name] = json.id;
      }
    }
  });

  const list = (query: string) =>
    same((t) => api(t, "GET", records(`?${query}`, "spots")));
  const titles = async (query: string) => {
    const snap = await list(query);
    return (snap.body as { items: { title: string }[] }).items.map(
      (i) => i.title,
    );
  };

  test("filter by lon", async () => {
    expect(
      await titles("filter=address.lon>24&sort=title&fields=title"),
    ).toEqual(["plovdiv"]);
  });

  test("filter by lat", async () => {
    expect(
      await titles("filter=address.lat<40&sort=title&fields=title"),
    ).toEqual(["athens", "lima"]);
  });

  test("filter by geoDistance", async () => {
    expect(
      await titles(
        "filter=geoDistance(address.lon, address.lat, 23.32, 42.69) < 25&sort=title&fields=title",
      ),
    ).toEqual(["sofia"]);
  });

  test("filter by geoDistance with a wider radius", async () => {
    expect(
      await titles(
        "filter=geoDistance(address.lon, address.lat, 23.32, 42.69) < 200&sort=title&fields=title",
      ),
    ).toEqual(["plovdiv", "sofia"]);
  });

  test("sort by address.lat", async () => {
    expect(await titles("sort=-address.lat&fields=title")).toEqual([
      "sofia",
      "plovdiv",
      "athens",
      "lima",
    ]);
  });

  test("sort by address.lon", () =>
    list("sort=address.lon&fields=title,address"));

  test("filter by the whole geoPoint value", () =>
    list('filter=address=\'{"lon":23.32,"lat":42.69}\'&fields=title'));

  test("editor filter with like", () => list("filter=body~'ofi'&fields=title"));

  test("update with a partial value", () =>
    same((t) =>
      api(t, "PATCH", records(`/${ids[t.name]}`, "spots"), {
        address: { lon: 10, lat: 20 },
      }),
    ));

  test("update with an invalid value", () =>
    same(
      (t) =>
        api(t, "PATCH", records(`/${ids[t.name]}`, "spots"), {
          address: { lon: 10, lat: 91 },
        }),
      400,
    ));
});
