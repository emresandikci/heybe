import type { App } from "./app";
import "./typegen.fixture";

export async function check(app: App) {
  await app.records("fx_posts").findMany({ where: { views: { gt: 1 } } });
  // @ts-expect-error unknown field
  await app.records("fx_posts").findMany({ where: { nope: 1 } });
  // @ts-expect-error wrong value type
  await app.records("fx_posts").findMany({ where: { views: "x" } });
}
