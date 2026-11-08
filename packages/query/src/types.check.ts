import type { Relation, WithExpand } from "./index.js";

declare module "./index.js" {
  interface Collections {
    chk_org: { id: string; title: string };
    chk_user: { id: string; name: string; org: Relation<"chk_org"> };
    chk_post: {
      id: string;
      author: Relation<"chk_user">;
      tags_rel: Relation<"chk_org">[];
      loose: Relation;
      lost: Relation<"chk_missing">;
    };
  }
}

type Post = import("./index.js").Collections["chk_post"];

type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;
const assert = <_T extends true>() => {};

declare const one: WithExpand<Post, { author: true }>;
const name: string | undefined = one.expand?.author?.name;
assert<
  Equal<
    NonNullable<typeof one.expand>["author"],
    import("./index.js").Collections["chk_user"] | undefined
  >
>();

declare const many: WithExpand<Post, { tags_rel: true }>;
assert<
  Equal<
    NonNullable<typeof many.expand>["tags_rel"],
    import("./index.js").Collections["chk_org"][] | undefined
  >
>();

declare const nested: WithExpand<Post, { author: { org: true } }>;
const orgTitle: string | undefined = nested.expand?.author?.expand?.org?.title;

declare const loose: WithExpand<Post, { loose: true; lost: true }>;
const looseValue: Record<string, unknown> | undefined = loose.expand?.loose;
const lostValue: Record<string, unknown> | undefined = loose.expand?.lost;

declare const via: WithExpand<Post, { comments_via_post: true }>;
const viaValue:
  Record<string, unknown> | Record<string, unknown>[] | undefined =
  via.expand?.comments_via_post;

declare const plain: WithExpand<Post, undefined>;
// @ts-expect-error no expand without an expand argument
plain.expand;

export { name, orgTitle, looseValue, lostValue, viaValue };
