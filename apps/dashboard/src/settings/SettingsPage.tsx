import type { ReactNode } from "react";
import { Page } from "../layout/Page";

export function SettingsPage({
  title,
  width,
  children,
}: {
  title: string;
  width?: "form" | "full";
  children: ReactNode;
}) {
  return (
    <Page
      width={width}
      crumbs={[{ label: "Settings", to: "/settings" }, { label: title }]}
    >
      {children}
    </Page>
  );
}
