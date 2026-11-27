import type { CollectionModel } from "@heybejs/client";
import { Navigate, Outlet, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useCollections } from "../app/queries";
import { useHideControls } from "../settings/use-settings";
import { RecordsPage } from "../records/RecordsPage";
import { EmptyState } from "@heybejs/ui";
import { Page } from "../layout/Page";
import { QueryStatus } from "../settings/QueryStatus";
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
      <div className="flex flex-col gap-6 md:flex-row">
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
  if (!collections.data) return <QueryStatus query={collections} />;
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
    <Page crumbs={[{ label: "Collections" }]} width="full">
      <EmptyState title="No collections yet">
        {!hideControls && <NewCollectionButton />}
      </EmptyState>
    </Page>
  );
}

export function CollectionPage() {
  const { collectionId } = useParams({ strict: false });
  const collections = useCollections();
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
    return settled ? (
      <Page
        crumbs={[
          { label: "Collections", to: "/collections" },
          { label: "Not found" },
        ]}
        width="full"
      >
        <EmptyState title="Collection not found" />
      </Page>
    ) : null;
  }
  return <RecordsPage key={collection.id} collection={collection} />;
}
