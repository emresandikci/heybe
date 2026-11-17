import type { CollectionModel } from "@heybe/client";
import { Navigate, Outlet, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useCollections } from "../app/queries";
import { useHideControls } from "../settings/use-settings";
import { RecordsPage } from "../records/RecordsPage";
import { Button, EmptyState } from "@heybe/ui";
import { ApiPreview } from "./ApiPreview";
import { CollectionEditor } from "./CollectionEditor";
import {
  CollectionsSidebar,
  EditorContext,
  NewCollectionButton,
} from "./CollectionsSidebar";

export function CollectionsLayout() {
  const [editing, setEditing] = useState<{
    collection?: CollectionModel;
  } | null>(null);
  return (
    <EditorContext.Provider value={(collection) => setEditing({ collection })}>
      <div className="flex gap-6">
        <CollectionsSidebar />
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
      {editing && (
        <CollectionEditor
          collection={editing.collection}
          onClose={() => setEditing(null)}
        />
      )}
    </EditorContext.Provider>
  );
}

export function CollectionsIndex() {
  const collections = useCollections();
  const hideControls = useHideControls();
  if (!collections.data) return null;
  const first = collections.data.find((c) => !c.system);
  if (first)
    return (
      <Navigate
        to="/collections/$collectionId"
        params={{ collectionId: first.id }}
        replace
      />
    );
  return (
    <EmptyState title="No collections yet">
      {!hideControls && <NewCollectionButton />}
    </EmptyState>
  );
}

export function CollectionPage() {
  const { collectionId } = useParams({ strict: false });
  const collections = useCollections();
  const [preview, setPreview] = useState(false);
  const [rechecked, setRechecked] = useState<string>();
  const collection = collections.data?.find(
    (c) => c.id === collectionId || c.name === collectionId,
  );
  const missing = !!collections.data && !collection;
  const { refetch } = collections;
  useEffect(() => {
    if (!missing || rechecked === collectionId) return;
    setRechecked(collectionId);
    void refetch();
  }, [missing, rechecked, collectionId, refetch]);
  if (!collection) {
    const settled = rechecked === collectionId && !collections.isFetching;
    return settled ? <EmptyState title="Collection not found" /> : null;
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{collection.name}</h2>
        <Button onClick={() => setPreview(true)}>API preview</Button>
      </div>
      <RecordsPage key={collection.id} collection={collection} />
      {preview && (
        <ApiPreview collection={collection} onClose={() => setPreview(false)} />
      )}
    </div>
  );
}
