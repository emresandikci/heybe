import { screen, within } from "@testing-library/react";
import type { CollectionModel } from "@heybe/client";
import { serveCollections } from "../test/editor";
import { fakeServer, type FakeServer } from "../test/fake-server";
import { collectionsFixture } from "../test/fixtures";

const base = collectionsFixture.find((c) => c.name === "posts")!;
const idField = base.fields[0]!;

const field = (type: string, name: string, extra: object = {}) => ({
  id: `${type}_${name}`,
  name,
  type,
  system: false,
  hidden: false,
  presentable: false,
  required: false,
  ...extra,
});

export const docs = (options: { protectedFiles?: boolean } = {}) =>
  ({
    ...base,
    id: "hbc_docs",
    name: "docs",
    fields: [
      idField,
      field("file", "cover", {
        maxSelect: 1,
        maxSize: 0,
        mimeTypes: [],
        thumbs: [],
        protected: !!options.protectedFiles,
      }),
      field("file", "gallery", {
        maxSelect: 3,
        maxSize: 0,
        mimeTypes: [],
        thumbs: [],
        protected: !!options.protectedFiles,
      }),
      field("relation", "owner", {
        collectionId: "_hb_users_auth_",
        maxSelect: 1,
        cascadeDelete: false,
      }),
      field("relation", "friends", {
        collectionId: "_hb_users_auth_",
        maxSelect: 2,
        cascadeDelete: false,
      }),
    ],
  }) as CollectionModel;

export const users = (): CollectionModel => {
  const users = collectionsFixture.find((c) => c.name === "users")!;
  return {
    ...users,
    fields: users.fields.map((f) =>
      f.name === "name" ? { ...f, presentable: true } : f,
    ),
  };
};

export function docsServer(options: { protectedFiles?: boolean } = {}) {
  const server: FakeServer = fakeServer();
  serveCollections(server, [docs(options), users()]);
  return server;
}

export const docRecord = (extra: object = {}) => ({
  id: "d1",
  collectionId: "hbc_docs",
  collectionName: "docs",
  cover: "",
  gallery: [],
  owner: "",
  friends: [],
  ...extra,
});

export async function openActions(
  user: ReturnType<typeof import("@testing-library/user-event").default.setup>,
  editor: ReturnType<typeof import("@testing-library/react").within>,
) {
  await user.click(editor.getByRole("button", { name: "More actions" }));
  return within(await screen.findByRole("menu"));
}

export async function pickAction(
  user: Parameters<typeof openActions>[0],
  editor: Parameters<typeof openActions>[1],
  name: string,
) {
  const menu = await openActions(user, editor);
  await user.click(menu.getByRole("menuitem", { name }));
}
