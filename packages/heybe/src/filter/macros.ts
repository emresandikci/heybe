import { formatDate } from "../util";
import { FilterError } from "./parse";

const DAY = 86_400_000;

export function macroValue(name: string, now: () => Date): string | number {
  const d = now();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const at = (
    ...parts: [number, number, number, number?, number?, number?, number?]
  ) => formatDate(new Date(Date.UTC(...parts)));

  switch (name) {
    case "@now":
      return formatDate(d);
    case "@yesterday":
      return formatDate(new Date(d.getTime() - DAY));
    case "@tomorrow":
      return formatDate(new Date(d.getTime() + DAY));
    case "@second":
      return d.getUTCSeconds();
    case "@minute":
      return d.getUTCMinutes();
    case "@hour":
      return d.getUTCHours();
    case "@day":
      return day;
    case "@month":
      return m + 1;
    case "@weekday":
      return d.getUTCDay();
    case "@year":
      return y;
    case "@todayStart":
      return at(y, m, day);
    case "@todayEnd":
      return at(y, m, day, 23, 59, 59, 999);
    case "@monthStart":
      return at(y, m, 1);
    case "@monthEnd":
      return at(y, m + 1, 0, 23, 59, 59, 999);
    case "@yearStart":
      return at(y, 0, 1);
    case "@yearEnd":
      return at(y, 11, 31, 23, 59, 59, 999);
  }
  throw new FilterError(`failed to resolve field "${name}"`);
}
