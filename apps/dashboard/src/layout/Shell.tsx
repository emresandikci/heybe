import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { signOut } from "../auth/session";
import { useClient } from "../app/context";
import { useSettings } from "../app/queries";
import { useTheme, type ThemeChoice } from "../app/theme";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { Sidebar } from "./Sidebar";

interface Meta {
  appName?: string;
  accentColor?: string;
}

export function Shell() {
  const client = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();
  const settings = useSettings();
  const meta = (settings.data?.meta ?? {}) as Meta;
  const accent = meta.accentColor || "#2563eb";
  useEffect(() => {
    document.documentElement.style.setProperty("--accent", accent);
    return () => {
      document.documentElement.style.removeProperty("--accent");
    };
  }, [accent]);
  const email = client.authStore.record?.email as string | undefined;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-slate-200 px-4 py-2 dark:border-slate-700">
        <h1 className="text-lg font-semibold">{meta.appName || "Heybe"}</h1>
        <div className="flex items-center gap-3">
          <Select
            label="Theme"
            value={theme}
            onChange={(e) => setTheme(e.target.value as ThemeChoice)}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </Select>
          {email && <span className="text-sm">{email}</span>}
          <Button
            onClick={() => {
              signOut({ client, queryClient });
              void navigate({ to: "/login" });
            }}
          >
            Sign out
          </Button>
        </div>
      </header>
      <div className="flex flex-1">
        <Sidebar />
        <main className="flex-1 p-4">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
