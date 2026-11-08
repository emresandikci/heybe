import type { Timers } from "../timers";
import { Schedule, momentOf } from "./schedule";

// Port of PB tools/cron/cron.go.

export interface CronJob {
  id: string;
  expression: string;
  run(): Promise<void>;
}

interface Job extends CronJob {
  schedule: Schedule;
}

export class CronScheduler {
  private list: Job[] = [];
  private timezone = "UTC";
  private interval = 60_000;
  private startTimer: unknown = null;
  private tickTimer: unknown = null;
  private started = false;
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly timers: Timers,
    private readonly now: () => Date,
  ) {}

  add(id: string, expr: string, fn: () => unknown): void {
    let schedule: Schedule;
    try {
      schedule = Schedule.parse(expr);
    } catch (err) {
      throw new Error(
        `failed to add new cron job: ${err instanceof Error ? err.message : err}`,
      );
    }
    this.remove(id);
    this.list.push({
      id,
      expression: schedule.expression,
      schedule,
      run: () => {
        const run = (async () => {
          try {
            await fn();
          } catch (err) {
            console.warn(`Cron job "${id}" failed`, err);
          }
        })();
        this.running.add(run);
        void run.then(() => this.running.delete(run));
        return run;
      },
    });
  }

  remove(id: string): void {
    this.list = this.list.filter((j) => j.id !== id);
  }

  removeAll(): void {
    this.list = [];
  }

  total(): number {
    return this.list.length;
  }

  jobs(): CronJob[] {
    return this.list.map(({ id, expression, run }) => ({
      id,
      expression,
      run,
    }));
  }

  setTimezone(tz: string): void {
    momentOf(this.now(), tz);
    this.timezone = tz;
  }

  setInterval(ms: number): void {
    this.interval = ms;
    if (this.started) this.start();
  }

  start(): void {
    void this.stop();
    const now = this.now().getTime();
    const first = now + this.interval - (now % this.interval);
    this.startTimer = this.timers.setTimeout(() => {
      this.startTimer = null;
      this.started = true;
      this.tick(first);
    }, first - now);
  }

  // resolves once the jobs already running have finished
  async stop(): Promise<void> {
    if (this.startTimer !== null) this.timers.clearTimeout(this.startTimer);
    if (this.tickTimer !== null) this.timers.clearTimeout(this.tickTimer);
    this.startTimer = this.tickTimer = null;
    this.started = false;
    await Promise.all(this.running);
  }

  hasStarted(): boolean {
    return this.started;
  }

  runDue(date: Date): void {
    const moment = momentOf(date, this.timezone);
    for (const job of this.list) if (job.schedule.isDue(moment)) void job.run();
  }

  // `at` is the intended tick time, so a timer that fires early or late neither skips nor repeats a tick
  private tick(at: number): void {
    this.runDue(new Date(at));
    const now = this.now().getTime();
    let next = at + this.interval;
    // like PB's ticker, ticks missed during a long pause are dropped, not replayed
    while (next <= now) next += this.interval;
    this.tickTimer = this.timers.setTimeout(() => this.tick(next), next - now);
  }
}
