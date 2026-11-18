import { Tooltip } from "@heybe/ui";
import { formatDate } from "../app/format";

const HOUR = 3_600_000;
const MIN_HOURS = 24;

const time = (ms: number) => formatDate(new Date(ms));

export function LogsChart({
  stats,
}: {
  stats: { total: number; date: string }[];
}) {
  if (stats.length === 0)
    return <p className="text-sm text-muted">No logs for this filter.</p>;
  const totals = new Map(
    stats.map((s) => [Date.parse(s.date.replace(" ", "T")), s.total]),
  );
  const times = [...totals.keys()];
  const last = Math.max(...times);
  const first = Math.min(Math.min(...times), last - (MIN_HOURS - 1) * HOUR);
  const slots = Array.from(
    { length: (last - first) / HOUR + 1 },
    (_, i) => first + i * HOUR,
  );
  const sum = stats.reduce((n, s) => n + s.total, 0);
  const max = Math.max(...stats.map((s) => s.total));
  const ticks = [...new Set([max, Math.round(max / 2), 0])];
  const labels = [
    first,
    first + Math.floor((slots.length - 1) / 2) * HOUR,
    last,
  ];

  return (
    <div
      role="img"
      aria-label={`Requests per hour, ${sum} in total`}
      className="flex gap-2 text-xs text-faint"
    >
      <div className="flex h-28 flex-col justify-between text-right tabular-nums">
        {ticks.map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex h-28 items-end border-b border-line-strong">
          {slots.map((slot) => {
            const total = totals.get(slot) ?? 0;
            const column = (
              <div
                key={slot}
                className="group flex h-full min-w-px flex-1 items-end justify-center"
              >
                <div
                  data-bar
                  style={{
                    height: `${total > 0 ? Math.max((total / max) * 100, 2) : 0}%`,
                    width: "calc(100% - 2px)",
                    maxWidth: 16,
                  }}
                  className="rounded-t-sm bg-accent group-hover:brightness-125"
                />
              </div>
            );
            return total > 0 ? (
              <Tooltip key={slot} content={`${time(slot)}: ${total}`}>
                {column}
              </Tooltip>
            ) : (
              column
            );
          })}
        </div>
        <div className="mt-1 flex justify-between">
          {labels.map((l) => (
            <span key={l}>{time(l)}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
