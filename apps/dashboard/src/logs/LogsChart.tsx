const BAR = 10;
const GAP = 2;
const HEIGHT = 80;

export function LogsChart({
  stats,
}: {
  stats: { total: number; date: string }[];
}) {
  if (stats.length === 0)
    return <p className="text-sm text-slate-500">No logs for this filter.</p>;
  const sorted = [...stats].sort((a, b) => a.date.localeCompare(b.date));
  const sum = sorted.reduce((n, s) => n + s.total, 0);
  const max = Math.max(...sorted.map((s) => s.total));
  const width = sorted.length * (BAR + GAP);
  return (
    <svg
      role="img"
      aria-label={`Requests per hour, ${sum} in total`}
      viewBox={`0 0 ${width} ${HEIGHT}`}
      preserveAspectRatio="none"
      className="h-24 w-full"
    >
      {sorted.map((s, i) => {
        const height = s.total > 0 ? Math.max((s.total / max) * HEIGHT, 1) : 0;
        return (
          <rect
            key={s.date}
            x={i * (BAR + GAP)}
            y={HEIGHT - height}
            width={BAR}
            height={height}
            fill="var(--accent)"
          >
            <title>{`${s.date.slice(0, 19)} UTC: ${s.total}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
