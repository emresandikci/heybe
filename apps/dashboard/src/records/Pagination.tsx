import { Button } from "../ui/Button";

export function Pagination({
  page,
  totalPages,
  totalItems,
  onPage,
}: {
  page: number;
  totalPages: number;
  totalItems: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span>{totalItems} records</span>
      <div className="flex items-center gap-2">
        <Button disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <span>
          Page {page} of {Math.max(totalPages, 1)}
        </span>
        <Button disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}
