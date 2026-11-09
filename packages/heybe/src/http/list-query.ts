import { FilterError, parseSort } from "../filter/parse";

const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 1000;
const MAX_FILTER_LENGTH = 3500;
const MAX_SORT_FIELDS = 8;
const MAX_SORT_FIELD_LENGTH = 255;
const INT64_MAX = 2n ** 63n - 1n;

function integer(value: string | null, fallback: number): number {
  if (value === null || value === "") return fallback;
  if (!/^[+-]?\d+$/.test(value) || BigInt(value) > INT64_MAX)
    throw new FilterError("invalid number");
  return Number(value);
}

// PB search.Provider.Parse and Exec: page, perPage and skipTotal.
export function parseListQuery(q: URLSearchParams): {
  page: number;
  perPage: number;
  skipTotal: boolean;
} {
  const skip = q.get("skipTotal") ?? "";
  if (!/^(1|t|T|TRUE|true|True|0|f|F|FALSE|false|False|)$/.test(skip))
    throw new FilterError("invalid skipTotal");
  const page = Math.max(integer(q.get("page"), 1), 1);
  let perPage = integer(q.get("perPage"), DEFAULT_PER_PAGE);
  if (perPage < 1) perPage = DEFAULT_PER_PAGE;
  return {
    page,
    perPage: Math.min(perPage, MAX_PER_PAGE),
    skipTotal: /^(1|t|T|TRUE|true|True)$/.test(skip),
  };
}

// PB search.Provider limits on the filter and sort query values.
export function checkFilterAndSortLimits(filter: string, sort: string): void {
  if (Buffer.byteLength(filter) > MAX_FILTER_LENGTH)
    throw new FilterError("max filter length limit reached");
  const fields = parseSort(sort);
  if (fields.length > MAX_SORT_FIELDS)
    throw new FilterError("max sort expressions limit reached");
  if (fields.some((s) => s.field.length > MAX_SORT_FIELD_LENGTH))
    throw new FilterError("max sort field length limit reached");
}
