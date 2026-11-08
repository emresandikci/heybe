import type { Relation } from "@heybe/query";

declare module "@heybe/query" {
  interface Collections {
    users: { id: string; email: string };
    posts: { id: string; status: string; author: Relation<"users"> };
  }
}
export {};
