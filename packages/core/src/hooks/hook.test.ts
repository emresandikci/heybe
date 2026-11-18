import { describe, expect, test } from "bun:test";
import { Hook, HookEvent } from "./hook";

class TagsEvent extends HookEvent {
  declare list: string[];

  override tags(): string[] {
    return this.list;
  }
}

describe("Hook", () => {
  test("bind orders by priority then insertion and replaces by id", async () => {
    let calls = "";
    const h = new Hook<HookEvent>();
    h.bind((e) => ((calls += "1"), e.next()));
    h.bind((e) => ((calls += "2"), e.next()));
    const id3 = h.bind((e) => ((calls += "3"), e.next()));
    h.bind((e) => ((calls += "3'"), e.next()), { id: id3 });
    h.bind((e) => ((calls += "4"), e.next()), { priority: -2 });
    h.bind((e) => ((calls += "5"), e.next()), { priority: -1 });
    h.bind((e) => ((calls += "6"), e.next()));
    h.bind(async (e) => {
      calls += "7";
      await e.next();
    });

    await h.trigger(
      new HookEvent(),
      (e) => ((calls += "8"), e.next()),
      () => {
        calls += "9";
      },
      (e) => ((calls += "10"), e.next()),
    );

    expect(h.length).toBe(7);
    expect(calls).toBe("45123'6789");
  });

  test("auto ids are 20 alphanumeric chars and unique", () => {
    const h = new Hook<HookEvent>();
    const ids = Array.from({ length: 50 }, () => h.bind(() => {}));
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9]{20}$/);
    expect(new Set(ids).size).toBe(50);
  });

  test("unbind removes matching ids, ignores unknown ones", async () => {
    let calls = "";
    const h = new Hook<HookEvent>();
    const id0 = h.bind((e) => ((calls += "0"), e.next()));
    const id1 = h.bind((e) => ((calls += "1"), e.next()));
    h.bind((e) => ((calls += "2"), e.next()));
    h.bind((e) => ((calls += "3"), e.next()));

    h.unbind("missing");
    expect(h.length).toBe(4);
    h.unbind(id1, id0);
    expect(h.length).toBe(2);

    await h.trigger(new HookEvent(), (e) => ((calls += "4"), e.next()));
    expect(calls).toBe("234");
  });

  test("unbindAll clears every handler", () => {
    const h = new Hook<HookEvent>();
    h.unbindAll();
    h.bind(() => {});
    h.bind(() => {});
    expect(h.length).toBe(2);
    h.unbindAll();
    expect(h.length).toBe(0);
  });

  test("a handler without next() stops the chain and skips the one-off", async () => {
    let action = false;
    const h = new Hook<HookEvent>();
    h.bind(() => {});
    await h.trigger(new HookEvent(), () => {
      action = true;
    });
    expect(action).toBe(false);
  });

  test("double next() is a no-op once the chain finished", async () => {
    let calls = "";
    const h = new Hook<HookEvent>();
    h.bind(async (e) => {
      calls += "a";
      await e.next();
      await e.next();
    });
    h.bind((e) => ((calls += "b"), e.next()));
    await h.trigger(new HookEvent(), (e) => ((calls += "c"), e.next()));
    expect(calls).toBe("abc");
  });

  test("like PB, a second next() after a later handler stopped resumes at the following one", async () => {
    let calls = "";
    const h = new Hook<HookEvent>();
    h.bind(async (e) => {
      calls += "a";
      await e.next();
      await e.next();
    });
    h.bind(() => {
      calls += "b";
    });
    h.bind((e) => ((calls += "c"), e.next()));
    await h.trigger(new HookEvent(), () => {
      calls += "d";
    });
    expect(calls).toBe("abcd");
  });

  test("re-triggering an event starts a fresh chain", async () => {
    let calls = "";
    const e = new HookEvent();
    const stopped = new Hook<HookEvent>();
    stopped.bind(() => {
      calls += "s";
    });
    stopped.bind(() => {
      calls += "stale";
    });
    await stopped.trigger(e);
    const next = new Hook<HookEvent>();
    next.bind((e) => ((calls += "x"), e.next()));
    await next.trigger(e, (e) => ((calls += "y"), e.next()));
    expect(calls).toBe("sxy");
  });

  test("errors propagate through next()", async () => {
    const err = new Error("test");
    const h = new Hook<HookEvent>();
    h.bind((e) => e.next());
    h.bind(async (e) => {
      await e.next();
      throw err;
    });
    h.bind((e) => e.next());
    await expect(h.trigger(new HookEvent())).rejects.toBe(err);

    const ok = new Hook<HookEvent>();
    ok.bind((e) => e.next());
    ok.bind((e) => e.next());
    expect(await ok.trigger(new HookEvent())).toBeUndefined();
  });

  test("an error thrown before next() reaches the trigger caller", async () => {
    const h = new Hook<HookEvent>();
    let action = false;
    h.bind(async (e) => {
      await e.next();
    });
    h.bind(() => {
      throw new Error("stop");
    });
    await expect(
      h.trigger(new HookEvent(), () => {
        action = true;
      }),
    ).rejects.toThrow("stop");
    expect(action).toBe(false);
  });

  test("code after await next() runs in reverse order", async () => {
    const calls: string[] = [];
    const h = new Hook<HookEvent>();
    for (const c of ["a", "b"])
      h.bind(async (e) => {
        calls.push(c);
        await e.next();
        calls.push(c + "'");
      });
    await h.trigger(new HookEvent(), () => {
      calls.push("action");
    });
    expect(calls).toEqual(["a", "b", "action", "b'", "a'"]);
  });

  test("extra set by one handler is visible to the next", async () => {
    const h = new Hook<HookEvent>();
    let seen: unknown;
    h.bind((e) => {
      e.extra.user = "x";
      return e.next();
    });
    h.bind((e) => {
      seen = e.extra.user;
      return e.next();
    });
    const e = new HookEvent();
    expect(e.extra).toEqual({});
    await h.trigger(e);
    expect(seen).toBe("x");
    expect(new HookEvent().extra).toEqual({});
  });

  test("events start with no tags and next() outside a chain is a no-op", async () => {
    const e = new HookEvent();
    expect(e.tags()).toEqual([]);
    expect(await e.next()).toBeUndefined();
  });

  test("tagged handlers run only for matching event tags", async () => {
    let calls = "";
    const h = new Hook<TagsEvent>();
    h.bind((e) => ((calls += "f0"), e.next()));
    h.bind((e) => ((calls += "a1"), e.next()), { tags: [] });
    h.bind((e) => ((calls += "a2"), e.next()), { priority: -1 });
    h.bind((e) => ((calls += "b1"), e.next()), { tags: ["b1", "b2"] });
    h.bind((e) => ((calls += "b2"), e.next()), {
      tags: ["b1", "b2"],
      priority: -2,
    });
    h.bind((e) => ((calls += "c1"), e.next()), { tags: ["c1", "c2"] });
    h.bind((e) => ((calls += "c2"), e.next()), {
      tags: ["c1", "c2"],
      priority: -3,
    });

    const scenarios: [string[], string][] = [
      [[], "a2f0a1"],
      [["missing"], "a2f0a1"],
      [["b2"], "b2a2f0a1b1"],
      [["c1"], "c2a2f0a1c1"],
      [["b1", "c2"], "c2b2a2f0a1b1c1"],
    ];
    for (const [list, expected] of scenarios) {
      calls = "";
      await h.trigger(TagsEvent.of({ list }));
      expect(calls).toBe(expected);
    }
  });
});
