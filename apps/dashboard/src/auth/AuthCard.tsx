import type { ComponentProps, ReactNode } from "react";
import { useFieldError } from "../app/errors";
import { TextField } from "../ui/TextField";

export function AuthCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-4 p-4">
      <h1 className="text-xl font-semibold">{title}</h1>
      {children}
    </main>
  );
}

export function Field({
  path,
  ...props
}: { path: string } & ComponentProps<typeof TextField>) {
  return <TextField {...props} error={useFieldError(path)} />;
}
