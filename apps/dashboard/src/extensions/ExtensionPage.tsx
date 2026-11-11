import { useEffect, useRef, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useClient, useExtensions } from "../app/context";
import { EmptyState } from "../ui/EmptyState";

export function ExtensionPage() {
  const path = useParams({ strict: false })._splat ?? "";
  const page = useExtensions().pages.find((p) => p.path === path);
  const client = useClient();
  const el = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!page) return;
    document.title = `${page.title} - Heybe`;
    setError(undefined);
    try {
      const cleanup = page.mount(el.current!, { client });
      return () => {
        try {
          cleanup?.();
        } catch (e) {
          console.warn(`Extension page "${page.path}" cleanup failed`, e);
        }
      };
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [page, client]);

  if (!page) return <EmptyState title="Page not found." />;
  if (error)
    return (
      <p role="alert" className="text-red-600">
        Extension "{page.title}" failed: {error}
      </p>
    );
  return <div ref={el} />;
}
