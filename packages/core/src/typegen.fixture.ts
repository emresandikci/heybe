import type { Relation } from "@heybejs/query";

declare module "@heybejs/query" {
  interface Collections {
    fx_posts: {
      id: string;
      title: string;
      views: number;
      tags: ("a" | "b")[];
      author: Relation<"fx_users">;
      body: string;
      location: { lon: number; lat: number };
      created: string;
      updated: string;
    };
    fx_users: {
      id: string;
      name: string;
      avatar: string;
      created: string;
      updated: string;
      email: string;
      emailVisibility: boolean;
      verified: boolean;
    };
  }
}
export {};
