import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { Check, ChevronDown, LogOut } from "lucide-react";
import { signOut } from "../auth/session";
import { useClient } from "../app/context";
import { useTheme, type ThemeChoice } from "../app/theme";
import { Button, Menu, type MenuItem } from "@heybe/ui";
import { useSettings } from "../settings/use-settings";
import { Sidebar } from "./Sidebar";

const icon = { size: 15, strokeWidth: 1.75 };

const themes: { key: ThemeChoice; label: string }[] = [
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
  { key: "system", label: "System" },
];

export function Shell() {
  const client = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();
  const appName = (useSettings().data?.meta as { appName?: string } | undefined)
    ?.appName;
  useEffect(() => {
    document.title = appName || "Heybe";
  }, [appName]);
  const email = client.authStore.record?.email as string | undefined;

  const items: MenuItem[] = [
    { heading: "Theme" },
    ...themes.map(({ key, label }) => ({
      key,
      label,
      checked: theme === key,
      icon: (
        <Check
          {...icon}
          aria-hidden
          className={theme === key ? "" : "invisible"}
        />
      ),
    })),
    { separator: true },
    { key: "sign-out", label: "Sign out", icon: <LogOut {...icon} /> },
  ];

  const onAction = (key: string) => {
    if (key === "sign-out") {
      signOut({ client, queryClient });
      void navigate({ to: "/login" });
    } else setTheme(key as ThemeChoice);
  };

  return (
    <div className="flex min-h-dvh bg-bg text-sm text-text">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-11 items-center justify-end gap-4 border-b border-line bg-bg px-4">
          {email && (
            <Menu
              trigger={
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<ChevronDown {...icon} className="order-1" />}
                >
                  {email}
                </Button>
              }
              items={items}
              onAction={onAction}
              placement="bottom-end"
            />
          )}
        </header>
        <main className="flex flex-1 flex-col p-4">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
