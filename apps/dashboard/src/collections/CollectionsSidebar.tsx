import type { CollectionModel } from "@heybejs/client";
import { Link, useParams } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  LayoutGrid,
  Plus,
  Search,
  Settings,
  Users,
  X,
} from "lucide-react";
import { createContext, useContext, useId, useState } from "react";
import { useCollections } from "../app/queries";
import { useHideControls } from "../settings/use-settings";
import { Button, inputClass } from "@heybejs/ui";
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
  const openEditor = useOpenEditor();
  const query = search.trim().toLowerCase();
  const matches = (collections.data ?? []).filter((c) =>
    c.name.toLowerCase().includes(query),
  );
  const system = matches.filter((c) => c.system);
  const { collectionId } = useParams({ strict: false });
  const activeIsSystem = (collections.data ?? []).some(
    (c) => c.system && (c.id === collectionId || c.name === collectionId),
  );
  const forcedOpen = query !== "" || activeIsSystem;
  const showSystem = systemOpen || forcedOpen;
  const systemId = useId();
  const [listOpen, setListOpen] = useState(false);
  const listId = useId();

  return (
    <>
      <nav
        aria-label="Collections"
        className="flex w-full flex-col gap-3 overflow-y-auto p-1 md:sticky md:-m-1 md:top-14 md:max-h-[calc(100dvh-4.5rem)] md:w-56 md:shrink-0 md:self-start"
      >
        <button
          type="button"
          aria-expanded={listOpen}
          aria-controls={listId}
          onClick={() => setListOpen(!listOpen)}
          className={`${rowClass} font-medium hover:bg-hover md:hidden`}
        >
          {listOpen ? (
            <ChevronDown {...iconProps} />
          ) : (
            <ChevronRight {...iconProps} />
          )}
          Collections
        </button>
        <div
          id={listId}
          className={`${listOpen ? "flex" : "hidden"} flex-col gap-3 md:flex`}
        >
          <div className="relative">
            <Search
              {...iconProps}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint"
            />
            <input
              type="text"
              aria-label="Search collections"
              placeholder="Search collections"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={`${inputClass} pr-8 pl-8`}
            />
            {search && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setSearch("")}
                className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-control text-faint hover:bg-hover hover:text-text focus-visible:outline-2 focus-visible:outline-focus"
              >
                <X {...iconProps} />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setOverview(true)}
            className={`${rowClass} text-left hover:bg-hover`}
          >
            <LayoutGrid {...iconProps} className="text-muted" />
            Overview
          </button>
          <CollectionList
            items={matches.filter((c) => !c.system)}
            editable={!hideControls}
            onNavigate={() => setListOpen(false)}
          />
          {system.length > 0 && (
            <div className="flex flex-col gap-1">
              <button
                type="button"
                aria-expanded={showSystem}
                aria-controls={systemId}
                disabled={forcedOpen}
                onClick={() => setSystemOpen(!systemOpen)}
                className="flex items-center gap-1 rounded-control px-1 text-left text-xs font-medium text-muted uppercase focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default"
              >
                {showSystem ? (
                  <ChevronDown size={13} strokeWidth={1.75} aria-hidden />
                ) : (
                  <ChevronRight size={13} strokeWidth={1.75} aria-hidden />
                )}
                System
              </button>
              <div id={systemId} hidden={!showSystem}>
                {showSystem && (
                  <CollectionList
                    items={system}
                    editable={!hideControls}
                    onNavigate={() => setListOpen(false)}
                  />
                )}
              </div>
            </div>
          )}
          {query !== "" && matches.length === 0 && (
            <p className="px-2 text-sm text-muted">No collections match</p>
          )}
          {!hideControls && (
            <Button
              variant="ghost"
              onClick={() => openEditor()}
              icon={<Plus {...iconProps} />}
              className="justify-start"
            >
              New collection
            </Button>
          )}
        </div>
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

const iconProps = { size: 15, strokeWidth: 1.75, "aria-hidden": true };

const rowClass =
  "flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-focus";

const TYPE_ICONS = { base: Database, auth: Users, view: Eye };

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
  onNavigate,
}: {
  items: CollectionModel[];
  editable: boolean;
  onNavigate: () => void;
}) {
  const openEditor = useOpenEditor();
  return (
    <ul className="flex flex-col gap-1">
      {items.map((c) => {
        const Icon = TYPE_ICONS[c.type];
        return (
          <li key={c.id} className="group relative flex items-center">
            <Link
              to="/collections/$collectionId"
              params={{ collectionId: c.id }}
              onClick={onNavigate}
              className={`${rowClass} min-w-0 hover:bg-hover`}
              activeProps={{
                "aria-current": "page",
                className: "bg-hover font-medium",
              }}
            >
              <Icon {...iconProps} className="shrink-0 text-muted" />
              <span className="truncate">{c.name}</span>
            </Link>
            {editable && (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Edit collection ${c.name}`}
                onClick={() => openEditor(c)}
                icon={<Settings size={14} strokeWidth={1.75} />}
                className="absolute right-1 w-7 px-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
