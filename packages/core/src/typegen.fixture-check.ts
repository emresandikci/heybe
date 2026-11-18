import type { App } from "./app";
import "./typegen.fixture";

export async function check(app: App) {
  await app.records("fx_posts").findMany({ where: { views: { gt: 1 } } });
  // @ts-expect-error unknown field
  await app.records("fx_posts").findMany({ where: { nope: 1 } });
  // @ts-expect-error wrong value type
  await app.records("fx_posts").findMany({ where: { views: "x" } });
  // @ts-expect-error unknown operator on a plain string field
  await app.records("fx_posts").findMany({ where: { title: { gtt: "x" } } });
  // @ts-expect-error wrong operator value type on a plain string field
  await app.records("fx_posts").findMany({ where: { title: { eq: 5 } } });
  await app.records("fx_posts").findMany({
    where: { author: { name: { like: "a" } } },
  });
  await app.records("fx_posts").findMany({ where: { author: "id" } });
  await app.records("fx_posts").findMany({
    where: { body: { like: "a" }, location: { lat: { gt: 1 } } },
  });
  await app.records("fx_posts").create({
    body: "<p>a</p>",
    location: { lon: 1, lat: 2 },
  });
  await app.records("fx_posts").create({ author: "id" as string });
  await app.records("fx_posts").findMany({
    expand: { author: true, comments_via_post: { user: true } },
  });
  await app.records("fx_posts").findOne("id", { expand: { author: true } });
  // @ts-expect-error expand of a non-relation field
  await app.records("fx_posts").findMany({ expand: { title: true } });
  // @ts-expect-error expand of a non-relation field
  await app.records("fx_posts").findOne("id", { expand: { views: true } });
  const expanded = await app
    .records("fx_posts")
    .findMany({ expand: { author: true } });
  const authorName: string | undefined =
    expanded.items[0]!.expand?.author?.name;
  const one = await app
    .records("fx_posts")
    .findOne("id", { expand: { author: true } });
  const oneName: string | undefined = one.expand?.author?.name;
  const plain = await app.records("fx_posts").findMany({});
  // @ts-expect-error no expand without an expand argument
  plain.items[0]!.expand;
  return [authorName, oneName];
}
