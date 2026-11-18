import os from "node:os";

interface QuietOptions {
  max?: number;
  timeoutMs?: number;
  pollMs?: number;
  loadavg?: () => number[];
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export async function waitForQuiet(opts: QuietOptions = {}): Promise<number> {
  const max =
    opts.max ??
    Number(process.env.BENCH_MAX_LOAD ?? os.availableParallelism() / 4);
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollMs = opts.pollMs ?? 5_000;
  const loadavg = opts.loadavg ?? os.loadavg;
  const sleep = opts.sleep ?? Bun.sleep;
  const log = opts.log ?? console.error;
  for (let waited = 0; ; waited += pollMs) {
    const load = loadavg()[0]!;
    if (load <= max) return load;
    if (waited >= timeoutMs)
      throw new Error(`machine busy: load ${load} > ${max}, not recording`);
    log(`waiting for load ${load} to drop below ${max}`);
    await sleep(pollMs);
  }
}
