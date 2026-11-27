import type { ComponentProps, ReactNode } from "react";
import { useFieldError } from "../app/errors";
import { TextField } from "@heybejs/ui";
import { Logo } from "../layout/Logo";

export function AuthCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg p-4">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-base border border-line bg-raised p-6">
        <Logo size={40} />
        <h1 className="text-xl font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}

export function Field({
  path,
  ...props
}: { path: string } & ComponentProps<typeof TextField>) {
  return <TextField {...props} error={useFieldError(path)} />;
}
