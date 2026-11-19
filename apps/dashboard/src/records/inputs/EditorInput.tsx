import { lazy, Suspense } from "react";
import { FieldShell, useFieldIds } from "@heybe/ui";

const RichTextEditor = lazy(() => import("./RichTextEditor"));

export interface EditorInputProps {
  name: string;
  value: string;
  error?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

export function EditorSkeleton({
  name,
  error,
}: Pick<EditorInputProps, "name" | "error">) {
  const ids = useFieldIds({ error });
  return (
    <FieldShell {...ids} label={name} error={error}>
      <div
        role="status"
        aria-label={`Loading ${name} editor`}
        className="h-52 animate-pulse rounded-control border border-field-line bg-field motion-reduce:animate-none"
      />
    </FieldShell>
  );
}

export function EditorInput(props: EditorInputProps) {
  return (
    <Suspense
      fallback={<EditorSkeleton name={props.name} error={props.error} />}
    >
      <RichTextEditor {...props} />
    </Suspense>
  );
}
