import type { Expand } from "./types.js";

// { author: true, comments_via_post: { user: true } } -> "author,comments_via_post.user"
export function toExpand(expand: Expand<unknown> | undefined): string {
  const paths = (tree: object, prefix: string): string[] =>
    Object.entries(tree).flatMap(([key, value]) => {
      if (value === true) return [prefix + key];
      if (typeof value !== "object" || value === null) return [];
      const nested = paths(value, `${prefix}${key}.`);
      return nested.length > 0 ? nested : [prefix + key];
    });
  return expand ? paths(expand, "").join(",") : "";
}
