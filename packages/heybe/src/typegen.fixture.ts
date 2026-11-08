import type { Relation } from "@heybe/query";

declare module "@heybe/query" {
  interface Collections {
    fx_posts: {
      id: string;
      title: string;
      views: number;
      tags: ("a" | "b")[];
      author: Relation;
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
