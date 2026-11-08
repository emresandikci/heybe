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
      run: async () => {
        try {
          await fn();
        } catch (err) {
          console.warn(`Cron job "${id}" failed`, err);
        }
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
    this.stop();
    const now = this.now().getTime();
    const first = now + this.interval - (now % this.interval);
    this.startTimer = this.timers.setTimeout(() => {
      this.startTimer = null;
      this.started = true;
      this.tick(first);
    }, first - now);
  }

  stop(): void {
    if (this.startTimer !== null) this.timers.clearTimeout(this.startTimer);
    if (this.tickTimer !== null) this.timers.clearTimeout(this.tickTimer);
    this.startTimer = this.tickTimer = null;
    this.started = false;
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
