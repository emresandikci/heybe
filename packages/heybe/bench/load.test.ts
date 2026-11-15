import { describe, expect, test } from "bun:test";
import { waitForQuiet } from "./load";

function fake(loads: number[]) {
  const sleeps: number[] = [];
  let i = 0;
  return {
    sleeps,
    opts: {
      loadavg: () => [loads[Math.min(i++, loads.length - 1)]!, 0, 0],
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      log: () => {},
    },
  };
}

describe("waitForQuiet", () => {
  test("returns at once when load is below max", async () => {
    const f = fake([1]);
    expect(await waitForQuiet({ ...f.opts, max: 2 })).toBe(1);
    expect(f.sleeps).toEqual([]);
  });

  test("polls until load drops", async () => {
    const f = fake([5, 3, 1.5]);
    expect(await waitForQuiet({ ...f.opts, max: 2, pollMs: 5_000 })).toBe(1.5);
    expect(f.sleeps).toEqual([5_000, 5_000]);
  });

  test("throws machine busy after timeoutMs", async () => {
    const f = fake([9]);
    await expect(
      waitForQuiet({ ...f.opts, max: 2, timeoutMs: 10_000, pollMs: 5_000 }),
    ).rejects.toThrow("machine busy: load 9 > 2, not recording");
    expect(f.sleeps).toEqual([5_000, 5_000]);
  });

  test("reads BENCH_MAX_LOAD", async () => {
    const prev = process.env.BENCH_MAX_LOAD;
    process.env.BENCH_MAX_LOAD = "7";
    try {
      const f = fake([6]);
      expect(await waitForQuiet(f.opts)).toBe(6);
      expect(f.sleeps).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.BENCH_MAX_LOAD;
      else process.env.BENCH_MAX_LOAD = prev;
    }
  });
});
