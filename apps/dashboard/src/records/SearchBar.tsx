import { useState } from "react";
import { Button, CodeArea, Menu, type CodeSuggest } from "@heybejs/ui";
import { readList, writeList } from "./storage";

const HISTORY_KEY = "hb_filter_history";

export function SearchBar({
  filter,
  error,
  label = "Filter records",
  placeholder = 'e.g. title ~ "hello" && created > "2026-01-01"',
  suggest,
  onSearch,
}: {
  filter: string;
  label?: string;
  placeholder?: string;
  suggest: CodeSuggest;
  error?: string;
  onSearch: (filter: string) => void;
}) {
  const [text, setText] = useState(filter);
  const [lastFilter, setLastFilter] = useState(filter);
  const [history, setHistory] = useState(() => readList(HISTORY_KEY));

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
      <div className="min-w-0 flex-1">
        <CodeArea
          label={label}
          hideLabel
          singleLine
          placeholder={placeholder}
          suggest={suggest}
          value={text}
          error={error}
          onChange={setText}
          onRun={() => submit(text.trim())}
        />
      </div>
      <Button
        disabled={!text && !filter}
        onClick={() => {
          setText("");
          onSearch("");
        }}
      >
        Clear
      </Button>
      <Menu
        trigger={
          <Button disabled={history.length === 0}>Recent filters</Button>
        }
        items={history.map((item) => ({ key: item, label: item }))}
        placement="bottom-end"
        onAction={(item) => {
          setText(item);
          submit(item);
        }}
      />
    </div>
  );
}
