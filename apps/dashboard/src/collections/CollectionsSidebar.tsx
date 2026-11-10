import type { CollectionModel } from "@heybe/client";
import { Link } from "@tanstack/react-router";
import { createContext, useContext, useState } from "react";
import { useCollections, useHideControls } from "../app/queries";
import { Button } from "../ui/Button";
import { TextField } from "../ui/TextField";
import { OverviewDialog } from "./OverviewDialog";

export const EditorContext = createContext<
  (collection?: CollectionModel) => void
>(() => {});

export const useOpenEditor = () => useContext(EditorContext);

export function CollectionsSidebar() {
  const collections = useCollections();
  const hideControls = useHideControls();
  const [search, setSearch] = useState("");
  const [systemOpen, setSystemOpen] = useState(false);
  const [overview, setOverview] = useState(false);
  const query = search.trim().toLowerCase();
  const matches = (collections.data ?? []).filter((c) =>
    c.name.toLowerCase().includes(query),
  );
  const system = matches.filter((c) => c.system);
  const showSystem = systemOpen || query !== "";

  return (
    <>
      <nav
        aria-label="Collections"
        className="flex w-56 shrink-0 flex-col gap-3"
      >
        <TextField
          label="Search collections"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <CollectionList
          items={matches.filter((c) => !c.system)}
          editable={!hideControls}
        />
        {system.length > 0 && (
          <div className="flex flex-col gap-1">
            <button
              type="button"
              aria-expanded={showSystem}
              onClick={() => setSystemOpen(!systemOpen)}
              className="text-left text-xs font-medium text-slate-500 uppercase"
            >
              System
            </button>
            {showSystem && (
              <CollectionList items={system} editable={!hideControls} />
            )}
          </div>
        )}
        {!hideControls && <NewCollectionButton />}
        <Button variant="ghost" onClick={() => setOverview(true)}>
          Overview
        </Button>
      </nav>
      {overview && (
        <OverviewDialog
          collections={collections.data ?? []}
          onClose={() => setOverview(false)}
        />
      )}
    </>
  );
}

export function NewCollectionButton() {
  const openEditor = useOpenEditor();
  return (
    <Button variant="primary" onClick={() => openEditor()}>
      New collection
    </Button>
  );
}

function CollectionList({
  items,
  editable,
}: {
  items: CollectionModel[];
  editable: boolean;
}) {
  const openEditor = useOpenEditor();
  return (
    <ul className="flex flex-col gap-1">
      {items.map((c) => (
        <li key={c.id} className="flex items-center gap-1">
          <Link
            to="/collections/$collectionId"
            params={{ collectionId: c.id }}
            className="flex-1 truncate rounded px-2 py-1 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
            activeProps={{ "aria-current": "page", className: "font-semibold" }}
          >
            {c.name}
          </Link>
          {editable && (
            <Button
              variant="ghost"
              aria-label={`Edit collection ${c.name}`}
              onClick={() => openEditor(c)}
            >
              Edit
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
