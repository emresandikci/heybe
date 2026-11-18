const day = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const short = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});
const full = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "shortOffset",
});

export function formatDate(
  value: string | Date,
  style: "short" | "full" = "short",
): string {
  const date = new Date(
    typeof value === "string" ? value.replace(" ", "T") : value,
  );
  if (Number.isNaN(date.getTime())) return String(value);
  return `${day.format(date)}, ${(style === "full" ? full : short).format(date)}`;
}
