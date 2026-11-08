import { expect, test } from "bun:test";
import { openDb } from "./db";

test("a failing COMMIT rolls back and leaves the db usable", () => {
  const db = openDb(":memory:");
  db.run("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
  db.run(
    "CREATE TABLE child (id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id))",
  );

  expect(() =>
    db.tx(() => {
      db.run("PRAGMA defer_foreign_keys = ON");
      db.run("INSERT INTO child (id, p) VALUES (1, 99)");
    }),
  ).toThrow();
  expect(db.query("SELECT * FROM child")).toEqual([]);

  db.tx(() => db.run("INSERT INTO parent (id) VALUES (1)"));
  expect(db.query("SELECT * FROM parent")).toEqual([{ id: 1 }]);
  db.close();
});

test("the statement cache stays bounded and evicted statements are re-prepared", () => {
  const db = openDb(":memory:");
  for (let i = 0; i < 1000; i++) db.get(`SELECT ${i} AS n`);
  expect(db.cacheSize()).toBeLessThanOrEqual(200);
  expect(db.get("SELECT 0 AS n")).toEqual({ n: 0 });
  db.close();
});

test("DDL statements are not cached", () => {
  const db = openDb(":memory:");
  const before = db.cacheSize();
  db.run("CREATE TABLE t (id INTEGER)");
  db.run("DROP TABLE t");
  expect(db.cacheSize()).toBe(before);
  db.close();
});
