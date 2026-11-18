import { Link } from "@tanstack/react-router";
import { EmptyState } from "@heybe/ui";
import { Page } from "./Page";

export function NotFound() {
  return (
    <Page crumbs={[{ label: "Page not found" }]}>
      <EmptyState title="This page does not exist.">
        <Link to="/collections" className="text-accent-text hover:underline">
          Collections
        </Link>
      </EmptyState>
    </Page>
  );
}
