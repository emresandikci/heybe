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
