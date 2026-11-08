// Port of PB tools/cron/schedule.go.

export interface Moment {
  minute: number;
  hour: number;
  day: number;
  month: number;
  dayOfWeek: number;
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const INT64_MAX = 2n ** 63n - 1n;
const INT64_MIN = -(2n ** 63n);

// Go strconv.Atoi, errors included
function atoi(s: string): number {
  if (!/^[+-]?\d+$/.test(s))
    throw new Error(
      `strconv.Atoi: parsing ${JSON.stringify(s)}: invalid syntax`,
    );
  const n = BigInt(s);
  if (n > INT64_MAX || n < INT64_MIN)
    throw new Error(
      `strconv.Atoi: parsing ${JSON.stringify(s)}: value out of range`,
    );
  return Number(n);
}

function parseSegment(segment: string, min: number, max: number): Set<number> {
  const slots = new Set<number>();
  for (const p of segment.split(",")) {
    const stepParts = p.split("/");
    let step: number;
    if (stepParts.length === 1) step = 1;
    else if (stepParts.length === 2) {
      step = atoi(stepParts[1]!);
      if (step < 1 || step > max)
        throw new Error(
          `invalid segment step boundary - the step must be between 1 and the ${max}`,
        );
    } else
      throw new Error(
        "invalid segment step format - must be in the format */n or 1-30/n",
      );

    let rangeMin: number;
    let rangeMax: number;
    if (stepParts[0] === "*") {
      rangeMin = min;
      rangeMax = max;
    } else {
      const rangeParts = stepParts[0]!.split("-");
      if (rangeParts.length === 1) {
        if (step !== 1)
          throw new Error(
            "invalid segment step - step > 1 could be used only with the wildcard or range format",
          );
        const parsed = atoi(rangeParts[0]!);
        if (parsed < min || parsed > max)
          throw new Error(
            "invalid segment value - must be between the min and max of the segment",
          );
        rangeMin = rangeMax = parsed;
      } else if (rangeParts.length === 2) {
        const parsedMin = atoi(rangeParts[0]!);
        if (parsedMin < min || parsedMin > max)
          throw new Error(
            `invalid segment range minimum - must be between ${min} and ${max}`,
          );
        rangeMin = parsedMin;
        const parsedMax = atoi(rangeParts[1]!);
        if (parsedMax < parsedMin || parsedMax > max)
          throw new Error(
            `invalid segment range maximum - must be between ${rangeMin} and ${max}`,
          );
        rangeMax = parsedMax;
      } else
        throw new Error(
          "invalid segment range format - the range must have 1 or 2 parts",
        );
    }
    for (let i = rangeMin; i <= rangeMax; i += step) slots.add(i);
  }
  return slots;
}

export class Schedule {
  private constructor(
    readonly expression: string,
    private readonly minutes: Set<number>,
    private readonly hours: Set<number>,
    private readonly days: Set<number>,
    private readonly months: Set<number>,
    private readonly daysOfWeek: Set<number>,
  ) {}

  static parse(expr: string): Schedule {
    const expression = MACROS[expr] ?? expr;
    const segments = expression.split(" ");
    if (segments.length !== 5)
      throw new Error(
        "invalid cron expression - must be a valid macro or to have exactly 5 space separated segments",
      );
    return new Schedule(
      expression,
      parseSegment(segments[0]!, 0, 59),
      parseSegment(segments[1]!, 0, 23),
      parseSegment(segments[2]!, 1, 31),
      parseSegment(segments[3]!, 1, 12),
      parseSegment(segments[4]!, 0, 6),
    );
  }

  isDue(m: Moment): boolean {
    return (
      this.minutes.has(m.minute) &&
      this.hours.has(m.hour) &&
      this.days.has(m.day) &&
      this.daysOfWeek.has(m.dayOfWeek) &&
      this.months.has(m.month)
    );
  }
}

export function momentOf(date: Date, timezone = "UTC"): Moment {
  if (timezone === "UTC")
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      day: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      dayOfWeek: date.getUTCDay(),
    };
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    })
      .formatToParts(date)
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  return {
    minute: parts.minute!,
    hour: parts.hour! % 24,
    day: parts.day!,
    month: parts.month!,
    dayOfWeek: new Date(
      Date.UTC(parts.year!, parts.month! - 1, parts.day!),
    ).getUTCDay(),
  };
}
