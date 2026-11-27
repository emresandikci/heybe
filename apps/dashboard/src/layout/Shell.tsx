import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { Check, ChevronDown, LogOut, Menu as MenuIcon } from "lucide-react";
import { signOut } from "../auth/session";
import { useClient } from "../app/context";
import { useTheme, type ThemeChoice } from "../app/theme";
import { Button, Menu, type MenuItem } from "@heybejs/ui";
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
  const [menuOpen, setMenuOpen] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = drawer.current;
    if (!dialog) return;
    if (menuOpen && !dialog.open) dialog.showModal();
    if (!menuOpen && dialog.open) dialog.close();
  }, [menuOpen]);

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
      <div className="sticky top-0 hidden h-dvh w-48 shrink-0 md:block">
        <Sidebar />
      </div>
      <dialog
        ref={drawer}
        aria-label="Menu"
        className="m-0 h-dvh max-h-dvh w-60 max-w-[85vw] bg-transparent p-0 backdrop:bg-scrim"
        onClick={(event) => {
          if (event.target === event.currentTarget) setMenuOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          setMenuOpen(false);
        }}
        onClose={() => {
          setMenuOpen(false);
          menuButton.current?.focus();
        }}
      >
        {menuOpen && <Sidebar onNavigate={() => setMenuOpen(false)} />}
      </dialog>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-11 items-center justify-end gap-4 border-b border-line bg-bg px-4">
          <button
            ref={menuButton}
            type="button"
            aria-label="Open menu"
            aria-haspopup="dialog"
            onClick={() => setMenuOpen(true)}
            className="mr-auto inline-flex size-8 items-center justify-center rounded-control text-muted hover:bg-hover hover:text-text focus-visible:outline-2 focus-visible:outline-focus md:hidden"
          >
            <MenuIcon size={17} strokeWidth={1.75} aria-hidden />
          </button>
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
