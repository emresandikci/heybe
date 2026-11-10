import { createClient } from "./index.js";
import "./types.fixture.js";

const heybe = createClient("http://localhost");
const posts = heybe.records("cl_posts");

posts.findMany({ where: { title: "a", views: { gt: 5 } } });
posts.findMany({ where: { tags: { each: { anyEq: "x" } } } });
// @ts-expect-error unknown field in where
posts.findMany({ where: { nope: 1 } });
// @ts-expect-error wrong value type
posts.findMany({ where: { views: "many" } });

async function typed() {
  const list = await posts.findMany({ expand: { author: true } });
  const email: string | undefined = list.items[0]!.expand?.author?.email;
  const id: string = list.items[0]!.id;
  const one = await posts.findOne("x", { expand: { author: true } });
  const name: string | undefined = one.expand?.author?.name;
  const first = await posts.findFirst({ expand: { author: true } });
  const created = await posts.create(
    { title: "a", cover: new File(["x"], "c.png") },
    { expand: { author: true } },
  );
  const title: string = created.title;
  return [email, id, name, first.title, title];
}

// @ts-expect-error expand of a non-relation field
posts.findMany({ expand: { title: true } });
// @ts-expect-error expand of a non-relation field
posts.findOne("x", { expand: { title: true } });

// @ts-expect-error no expand without an expand argument
(await posts.findOne("x")).expand;

// @ts-expect-error excess expand key next to a valid one
posts.findMany({ expand: { author: true, title: true } });
// @ts-expect-error excess expand key
posts.findFirst({ expand: { title: true } });
// @ts-expect-error excess expand key
posts.create({ title: "a" }, { expand: { title: true } });
// @ts-expect-error unknown top-level key
posts.findMany({ wher: { title: "a" } });
// @ts-expect-error unknown top-level key
posts.findFirst({ limit: 1 });
// @ts-expect-error wrong field type on create
posts.create({ views: "many" });
// @ts-expect-error unknown field on create
posts.create({ nope: 1 });
// @ts-expect-error wrong field type on update
posts.update("x", { views: "many" });
// @ts-expect-error unknown field on update
posts.update("x", { nope: 1 });
// @ts-expect-error invalid orderBy field
posts.findMany({ orderBy: { nope: "asc" } });
// @ts-expect-error invalid orderBy direction
posts.findMany({ orderBy: { title: "up" } });

posts.update("x", { "tags+": "a", "cover-": ["old.png"] });
posts.create(new FormData());

const loose = heybe.records("anything");
loose.findMany({ where: { whatever: 1 } });
const looseValue: Promise<Record<string, unknown>> = loose.findOne("x");

export { typed, looseValue };

heybe.logs.findMany({ where: { "data.status": { gte: 400 } } });
// @ts-expect-error unknown log field
heybe.logs.findMany({ where: { nope: 1 } });

posts.findMany({ filter: "x", sort: "-created" });
// @ts-expect-error unknown top-level key
posts.findMany({ nope: 1 });
