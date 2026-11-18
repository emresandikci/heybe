const days = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const every = (n: string, unit: string) =>
  n === "1" ? `every ${unit}` : `every ${n} ${unit}s`;

const time = (hour: string, minute: string) =>
  `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;

export function describeCron(expression: string): string | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (dom !== "*" || month !== "*") return null;
  const step = /^\*\/(\d+)$/;
  const number = /^\d+$/;

  if (hour === "*" && dow === "*") {
    if (minute === "*") return "every minute";
    if (minute === "0") return "every hour";
    const m = step.exec(minute);
    return m ? every(m[1]!, "minute") : null;
  }
  if (minute === "0" && dow === "*") {
    if (hour === "*") return "every hour";
    const h = step.exec(hour);
    if (h) return every(h[1]!, "hour");
  }
  if (!number.test(minute) || !number.test(hour)) return null;
  if (dow === "*") return `daily at ${time(hour, minute)}`;
  if (number.test(dow) && Number(dow) <= 7)
    return `weekly on ${days[Number(dow) % 7]} at ${time(hour, minute)}`;
  return null;
}
