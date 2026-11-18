import type { Timers } from "./timers";

export function fakeClock(start = "2026-01-01T00:00:00Z") {
  let time = Date.parse(start);
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let waiting: (() => void)[] = [];
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      pending.set(++seq, { at: time + ms, fn });
      for (const resolve of waiting) resolve();
      waiting = [];
      return seq;
    },
    clearTimeout: (h) => void pending.delete(h as number),
  };
  return {
    now: () => new Date(time),
    timers,
    pending: () => pending.size,
    // resolves at the next setTimeout call
    scheduled: () => new Promise<void>((resolve) => waiting.push(resolve)),
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const due = [...pending]
          .filter(([, t]) => t.at <= end)
          .sort(([, a], [, b]) => a.at - b.at)[0];
        if (!due) break;
        pending.delete(due[0]);
        time = due[1].at;
        due[1].fn();
      }
      time = end;
    },
  };
}
