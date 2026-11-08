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
  await app.records("fx_posts").create({ author: "id" as string });
}
