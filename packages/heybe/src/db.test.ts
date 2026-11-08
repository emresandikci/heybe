import { expect, test } from "bun:test";
import { statementCacheSize } from "./db";
import { tempDb } from "./test-db";

const deferred = () => Promise.withResolvers<void>();
const ids = (db: ReturnType<typeof tempDb>) =>
  db.query<{ id: number }>("SELECT id FROM t ORDER BY id").map((r) => r.id);

function withTable() {
  const db = tempDb();
  db.run("CREATE TABLE t (id INTEGER PRIMARY KEY)");
  return db;
}

test("a failing COMMIT rolls back and leaves the db usable", () => {
  const db = tempDb();
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

test("statementCacheSize stays bounded and evicted statements are re-prepared", () => {
  const db = tempDb();
  for (let i = 0; i < 1000; i++) db.get(`SELECT ${i} AS n`);
  expect(statementCacheSize(db)).toBeLessThanOrEqual(200);
  expect(db.get("SELECT 0 AS n")).toEqual({ n: 0 });
  db.close();
});

test("DDL statements are not cached", () => {
  const db = tempDb();
  const before = statementCacheSize(db);
  db.run("CREATE TABLE t (id INTEGER)");
  db.run("DROP TABLE t");
  expect(statementCacheSize(db)).toBe(before);
  db.close();
});

test("reads outside a write never see its uncommitted rows", async () => {
  const db = withTable();
  const gate = deferred();
  const inserted = deferred();
  const writing = db.write(async () => {
    db.run("INSERT INTO t (id) VALUES (1)");
    expect(ids(db)).toEqual([1]);
    inserted.resolve();
    await gate.promise;
  });
  await inserted.promise;
  expect(db.get("SELECT id FROM t WHERE id = 1")).toBeNull();
  gate.resolve();
  await writing;
  expect(db.get("SELECT id FROM t WHERE id = 1")).toEqual({ id: 1 });
  db.close();
});

test("concurrent writes are serialized", async () => {
  const db = tempDb();
  db.run("CREATE TABLE counter (n INTEGER)");
  db.run("INSERT INTO counter (n) VALUES (0)");
  const increment = () =>
    db.write(async () => {
      const { n } = db.get<{ n: number }>("SELECT n FROM counter")!;
      await Promise.resolve();
      db.run("UPDATE counter SET n = ?", [n + 1]);
    });
  await Promise.all([increment(), increment()]);
  expect(db.get("SELECT n FROM counter")).toEqual({ n: 2 });
  db.close();
});

test("nested write uses a savepoint", async () => {
  const db = withTable();
  await db.write(async () => {
    db.run("INSERT INTO t (id) VALUES (1)");
    await db
      .write(() => {
        db.run("INSERT INTO t (id) VALUES (2)");
        throw new Error("inner");
      })
      .catch(() => {});
    await db.write(() => db.run("INSERT INTO t (id) VALUES (3)"));
  });
  expect(ids(db)).toEqual([1, 3]);
  db.close();
});

test("un-awaited nested write is committed with its parent", async () => {
  const db = withTable();
  const gate = deferred();
  await db.write(() => {
    void db.write(async () => {
      await gate.promise;
      db.run("INSERT INTO t (id) VALUES (1)");
    });
    gate.resolve();
  });
  expect(ids(db)).toEqual([1]);
  db.close();
});

test("write started from a timer after commit runs in its own transaction", async () => {
  const db = withTable();
  const timer = deferred();
  let late: Promise<unknown> | undefined;
  await db.write(() => {
    // a continuation keeps the write's context, like a timer set inside it
    late = timer.promise.then(() =>
      db.write(() => db.run("INSERT INTO t (id) VALUES (2)")),
    );
    db.run("INSERT INTO t (id) VALUES (1)");
  });
  timer.resolve();
  await late;
  expect(ids(db)).toEqual([1, 2]);
  expect(() => db.run("INSERT INTO t (id) VALUES (3)")).not.toThrow();
  db.close();
});

test("write started late from a finished nested write joins the open parent", async () => {
  const db = withTable();
  const timer = deferred();
  const called = deferred();
  const lateGate = deferred();
  let late: Promise<unknown> | undefined;
  await db.write(async () => {
    await db.write(() => {
      late = timer.promise.then(() => {
        const write = db.write(async () => {
          db.run("INSERT INTO t (id) VALUES (9)");
          await lateGate.promise;
        });
        called.resolve();
        return write;
      });
    });
    await db.write(async () => {
      db.run("INSERT INTO t (id) VALUES (2)");
      timer.resolve();
      await called.promise;
    });
    lateGate.resolve();
  });
  await late;
  expect(ids(db)).toEqual([2, 9]);
  db.close();
});

test("a write started microtasks after its parent's body returns is not lost", async () => {
  const later = (ticks: number, fn: () => unknown) => {
    let p = Promise.resolve();
    for (let i = 0; i < ticks; i++) p = p.then(() => {});
    return p.then(fn);
  };
  for (const nested of [false, true])
    for (let ticks = 0; ticks < 6; ticks++) {
      const db = withTable();
      let late: Promise<unknown> | undefined;
      const body = () => {
        db.run("INSERT INTO t (id) VALUES (1)");
        late = later(ticks, () =>
          db.write(() => db.run("INSERT INTO t (id) VALUES (9)")),
        );
      };
      await db.write(nested ? () => db.write(body) : body);
      await late;
      expect(ids(db)).toEqual([1, 9]);
      db.close();
    }
});

test("a rolled back nested write completes with its own error", async () => {
  const db = withTable();
  const seen: unknown[] = [];
  const undo = new Error("undo");
  await db.write(async () => {
    await db
      .write(async () => {
        await db.write(() => db.onComplete((err) => seen.push(["inner", err])));
        db.onComplete((err) => seen.push(["middle", err]));
        throw undo;
      })
      .catch(() => {});
    db.onComplete((err) => seen.push(["outer", err]));
  });
  expect(seen).toEqual([
    ["inner", undo],
    ["middle", undo],
    ["outer", null],
  ]);
  db.close();
});

test("concurrent nested siblings are serialized", async () => {
  const db = withTable();
  const order: string[] = [];
  await db.write(async () => {
    await Promise.allSettled([
      db.write(async () => {
        order.push("a");
        db.run("INSERT INTO t (id) VALUES (1)");
        await Promise.resolve();
        db.run("INSERT INTO t (id) VALUES (2)");
        order.push("a end");
      }),
      db.write(() => {
        order.push("b");
        db.run("INSERT INTO t (id) VALUES (3)");
        throw new Error("b");
      }),
    ]);
  });
  expect(order).toEqual(["a", "a end", "b"]);
  expect(ids(db)).toEqual([1, 2]);
  db.close();
});

test("every onComplete callback runs and their errors are joined", async () => {
  const db = withTable();
  const ran: number[] = [];
  const write = db.write(() => {
    db.onComplete(() => {
      ran.push(1);
      throw new Error("one");
    });
    db.onComplete(() => {
      ran.push(2);
      throw new Error("two");
    });
    db.run("INSERT INTO t (id) VALUES (1)");
  });
  await expect(write).rejects.toBeInstanceOf(AggregateError);
  expect(ran).toEqual([1, 2]);
  expect(ids(db)).toEqual([1]);
  db.close();
});

test("throwing write rolls back and the next write succeeds", async () => {
  const db = withTable();
  await expect(
    db.write(async () => {
      db.run("INSERT INTO t (id) VALUES (1)");
      await Promise.resolve();
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  await db.write(() => db.run("INSERT INTO t (id) VALUES (2)"));
  expect(ids(db)).toEqual([2]);
  db.close();
});

test("onComplete runs after COMMIT with null and after ROLLBACK with the error", async () => {
  const db = withTable();
  const seen: unknown[] = [];
  await db.write(async () => {
    db.onComplete((err) => seen.push(["outer", err, ids(db)]));
    await db.write(() => {
      db.run("INSERT INTO t (id) VALUES (1)");
      db.onComplete((err) => seen.push(["inner", err]));
    });
    expect(seen).toEqual([]);
  });
  expect(seen).toEqual([
    ["outer", null, [1]],
    ["inner", null],
  ]);

  const boom = new Error("boom");
  seen.length = 0;
  await db
    .write(() => {
      db.onComplete((err) => seen.push(err));
      throw boom;
    })
    .catch(() => {});
  expect(seen).toEqual([boom]);

  db.onComplete((err) => seen.push(err));
  expect(seen).toEqual([boom, null]);
  db.close();
});

test("reader is query_only", () => {
  const db = withTable();
  expect(() =>
    db.query("INSERT INTO t (id) VALUES (1) RETURNING id"),
  ).toThrow();
  db.close();
});

test("run outside write throws while a write is open", async () => {
  const db = withTable();
  const gate = deferred();
  const writing = db.write(() => gate.promise);
  await Promise.resolve();
  const message =
    "heybe: db write outside db.write while a write transaction is open";
  expect(() => db.run("INSERT INTO t (id) VALUES (1)")).toThrow(message);
  expect(() => db.tx(() => 1)).toThrow(message);
  expect(db.committed(() => ids(db))).toEqual([]);
  gate.resolve();
  await writing;
  db.close();
});
