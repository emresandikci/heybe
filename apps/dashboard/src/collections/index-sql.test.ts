import { expect, test } from "bun:test";
import { buildIndex, parseIndex } from "./index-sql";

test("buildIndex builds unique and non-unique statements", () => {
  expect(
    buildIndex({
      table: "posts",
      columns: ["a", "b"],
      unique: true,
      name: "idx_x",
    }),
  ).toBe("CREATE UNIQUE INDEX `idx_x` ON `posts` (`a`, `b`)");
  expect(buildIndex({ table: "posts", columns: ["a"], unique: false })).toMatch(
    /^CREATE INDEX `idx_[a-zA-Z0-9]{10}` ON `posts` \(`a`\)$/,
  );
});

test("parseIndex reads name, unique, table and columns and returns null for garbage", () => {
  expect(
    parseIndex(
      "CREATE UNIQUE INDEX IF NOT EXISTS `idx_x` ON `posts` (`a` DESC, b COLLATE NOCASE, lower(c)) WHERE a != ''",
    ),
  ).toEqual({
    name: "idx_x",
    unique: true,
    table: "posts",
    columns: ["a", "b", "lower"],
    simple: false,
  });
  expect(parseIndex("create index idx_y on posts (title)")).toEqual({
    name: "idx_y",
    unique: false,
    table: "posts",
    columns: ["title"],
    simple: true,
  });
  expect(
    parseIndex("CREATE INDEX main.`x` ON `posts` (\n  `a`,\n  `b`\n);"),
  ).toEqual({
    name: "x",
    unique: false,
    table: "posts",
    columns: ["a", "b"],
    simple: true,
  });
  expect(parseIndex("CREATE INDEX x ON posts (a) WHERE a > 1")?.simple).toBe(
    false,
  );
  expect(parseIndex("DROP TABLE posts")).toBeNull();
  expect(parseIndex("CREATE INDEX `idx` ON `posts` (`a`")).toBeNull();
  expect(parseIndex("CREATE INDEX `idx` ON `posts` ()")).toBeNull();
});
