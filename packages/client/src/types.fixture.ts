import type { Relation } from "@heybejs/query";

declare module "@heybejs/query" {
  interface Collections {
    cl_users: { id: string; email: string; name: string };
    cl_posts: {
      id: string;
      title: string;
      views: number;
      tags: string[];
      author: Relation<"cl_users">;
      cover: string;
    };
  }
}

export type { Relation };
