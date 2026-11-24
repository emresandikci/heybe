import { expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { renderApp } from "../test/render";
import { docRecord, docsServer } from "./editor-fixtures";

const person = (id: string, name: string) => ({
  id,
  collectionId: "_hb_users_auth_",
  collectionName: "users",
  name,
});

const serveUsers = (
  server = docsServer(),
  items = [person("u1", "Ada"), person("u2", "Bob"), person("u3", "Cyd")],
) =>
  server.on("GET", "/api/collections/users/records", (req) => ({
    page: Number(req.query.get("page") ?? 1),
    perPage: Number(req.query.get("perPage")),
    totalItems: items.length,
    totalPages: 1,
    items,
  }));

const group = async (name: string) =>
  within(await screen.findByRole("group", { name }));

const create = () => {
  const server = serveUsers().on(
    "POST",
    "/api/collections/docs/records",
    docRecord(),
  );
  return {
    ...renderApp({ path: "/collections/hbc_docs?record=new", server }),
    server,
  };
};

const picker = () =>
  within(screen.getByRole("dialog", { name: "Choose owner" }));

test("the picker search sends the raw filter to the target collection", async () => {
  const { server, user } = create();
  const owner = await group("owner");
  await user.click(owner.getByRole("button", { name: "Choose records" }));
  const dialog = within(
    await screen.findByRole("dialog", { name: "Choose owner" }),
  );
  await dialog.findByText("Ada");
  await user.type(dialog.getByLabelText("Search"), 'name ~ "a b"{Enter}');
  await dialog.findByText("Ada");
  const last = server.find("GET", "/api/collections/users/records").at(-1)!;
  expect(last.query.get("filter")).toBe('name ~ "a b"');
  expect(last.query.get("perPage")).toBe("40");
  expect(last.query.get("sort")).toBe("-@rowid");
});

test("the picker says when the target collection has no records", async () => {
  const { user } = renderApp({
    path: "/collections/hbc_docs?record=new",
    server: serveUsers(undefined, []),
  });
  const owner = await group("owner");
  await user.click(owner.getByRole("button", { name: "Choose records" }));
  await picker().findByText("No records yet.");
});

test("single relation replaces the selection", async () => {
  const { server, user } = create();
  const owner = await group("owner");
  await user.click(owner.getByRole("button", { name: "Choose records" }));
  await user.click(await picker().findByRole("radio", { name: "Ada" }));
  await user.click(picker().getByRole("radio", { name: "Bob" }));
  await user.click(picker().getByRole("button", { name: "Select" }));
  expect(owner.getByText("Bob")).toBeTruthy();
  expect(owner.queryByText("Ada")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Create" }));
  await screen.findByText("Record saved.");
  expect(server.find("POST", "/api/collections/docs/records")[0]!.body).toEqual(
    { owner: "u2" },
  );
});

test("multiple relation stops at maxSelect and sends an array", async () => {
  const { server, user } = create();
  const friends = await group("friends");
  await user.click(friends.getByRole("button", { name: "Choose records" }));
  const dialog = within(
    await screen.findByRole("dialog", { name: "Choose friends" }),
  );
  await user.click(await dialog.findByRole("checkbox", { name: "Ada" }));
  await user.click(dialog.getByRole("checkbox", { name: "Bob" }));
  expect(
    (dialog.getByRole("checkbox", { name: "Cyd" }) as HTMLInputElement)
      .disabled,
  ).toBe(true);
  await user.click(dialog.getByRole("checkbox", { name: "Ada" }));
  expect(
    (dialog.getByRole("checkbox", { name: "Cyd" }) as HTMLInputElement)
      .disabled,
  ).toBe(false);
  await user.click(dialog.getByRole("checkbox", { name: "Cyd" }));
  await user.click(dialog.getByRole("button", { name: "Select" }));
  await user.click(screen.getByRole("button", { name: "Create" }));
  await screen.findByText("Record saved.");
  expect(server.find("POST", "/api/collections/docs/records")[0]!.body).toEqual(
    {
      friends: ["u2", "u3"],
    },
  );
});

test("chips show presentable values from expand and can be removed", async () => {
  const server = serveUsers().on(
    "PATCH",
    "/api/collections/docs/records/:id",
    docRecord(),
  );
  server.on(
    "GET",
    "/api/collections/docs/records/:id",
    docRecord({
      owner: "u1",
      friends: ["u2", "u9"],
      expand: { owner: person("u1", "Ada"), friends: [person("u2", "Bob")] },
    }),
  );
  const { user } = renderApp({
    path: "/collections/hbc_docs?record=d1",
    server,
  });
  const owner = await group("owner");
  expect(await owner.findByText("Ada")).toBeTruthy();
  const friends = await group("friends");
  expect(friends.getByText("Bob")).toBeTruthy();
  expect(friends.getByText("u9")).toBeTruthy();
  expect(
    server
      .find("GET", "/api/collections/docs/records/:id")[0]!
      .query.get("expand"),
  ).toBe("owner,friends");
  await user.click(friends.getByRole("button", { name: "Remove Bob" }));
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Record saved.");
  expect(
    server.find("PATCH", "/api/collections/docs/records/:id")[0]!.body,
  ).toEqual({
    friends: ["u9"],
  });
});

test("Load more fetches the next page", async () => {
  const server = docsServer().on(
    "GET",
    "/api/collections/users/records",
    (req) => {
      const page = Number(req.query.get("page"));
      return {
        page,
        perPage: 40,
        totalItems: 2,
        totalPages: 2,
        items: [person(`u${page}`, page === 1 ? "Ada" : "Bob")],
      };
    },
  );
  const { user } = renderApp({
    path: "/collections/hbc_docs?record=new",
    server,
  });
  const owner = await group("owner");
  await user.click(owner.getByRole("button", { name: "Choose records" }));
  await picker().findByText("Ada");
  await user.click(picker().getByRole("button", { name: "Load more" }));
  expect(await picker().findByText("Bob")).toBeTruthy();
  expect(picker().queryByRole("button", { name: "Load more" })).toBeNull();
});

test("adding a record keeps the labels of the already selected ones", async () => {
  const server = serveUsers();
  server.on(
    "GET",
    "/api/collections/docs/records/:id",
    docRecord({
      friends: ["u2"],
      expand: { friends: [person("u2", "Bob")] },
    }),
  );
  const { user } = renderApp({
    path: "/collections/hbc_docs?record=d1",
    server,
  });
  const friends = await group("friends");
  await friends.findByText("Bob");
  await user.click(friends.getByRole("button", { name: "Choose records" }));
  const dialog = within(
    await screen.findByRole("dialog", { name: "Choose friends" }),
  );
  await user.click(await dialog.findByRole("checkbox", { name: "Cyd" }));
  await user.click(dialog.getByRole("button", { name: "Select" }));
  expect(friends.getByText("Bob")).toBeTruthy();
  expect(friends.getByText("Cyd")).toBeTruthy();
});
