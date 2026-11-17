import { useState } from "react";
import { Button, TextField } from "@heybe/ui";
import { readList, writeList } from "./storage";

const HISTORY_KEY = "heybe_filter_history";

export function SearchBar({
  filter,
  error,
  label = "Filter records",
  onSearch,
}: {
  filter: string;
  label?: string;
  error?: string;
  onSearch: (filter: string) => void;
}) {
  const [text, setText] = useState(filter);
  const [lastFilter, setLastFilter] = useState(filter);
  const [history, setHistory] = useState(() => readList(HISTORY_KEY));
  const [menu, setMenu] = useState(false);

  if (filter !== lastFilter) {
    setLastFilter(filter);
    setText(filter);
  }

  const submit = (value: string) => {
    if (value) {
      const next = [value, ...history.filter((h) => h !== value)].slice(0, 10);
      setHistory(next);
      writeList(HISTORY_KEY, next);
    }
    onSearch(value);
  };

  return (
    <div className="flex items-start gap-2">
      <div className="flex-1">
        <TextField
          label={label}
          placeholder={'e.g. title ~ "hello" && created > "2026-01-01"'}
          value={text}
          error={error}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit(text.trim());
            }
          }}
        />
      </div>
      <div className="relative mt-6 flex gap-2">
        <Button
          onClick={() => {
            setText("");
            onSearch("");
          }}
        >
          Clear
        </Button>
        <Button aria-expanded={menu} onClick={() => setMenu(!menu)}>
          Recent filters
        </Button>
        {menu && (
          <ul
            aria-label="Recent filters"
            className="absolute right-0 top-full z-10 flex min-w-64 flex-col rounded border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
          >
            {history.map((item) => (
              <li key={item}>
                <button
                  type="button"
                  className="w-full px-3 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                  onClick={() => {
                    setText(item);
                    setMenu(false);
                    submit(item);
                  }}
                >
                  {item}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
