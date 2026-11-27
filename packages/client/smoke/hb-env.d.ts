import type { Relation } from "@heybejs/query";

declare module "@heybejs/query" {
  interface Collections {
    users: { id: string; email: string };
    posts: { id: string; status: string; author: Relation<"users"> };
  }
}
export {};
