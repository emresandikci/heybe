import { Link, Outlet } from "@tanstack/react-router";
import { useHideControls } from "./use-settings";

const links = [
  { to: "/settings", label: "Application" },
  { to: "/settings/mail", label: "Mail" },
  { to: "/settings/storage", label: "File storage" },
  { to: "/settings/backups", label: "Backups" },
  { to: "/settings/crons", label: "Crons" },
  { to: "/settings/export-collections", label: "Export collections" },
  { to: "/settings/import-collections", label: "Import collections" },
  { to: "/settings/sql", label: "SQL" },
] as const;

export function SettingsLayout() {
  const hideControls = useHideControls();
  return (
    <div className="flex gap-6">
      <nav aria-label="Settings" className="flex w-48 shrink-0 flex-col gap-1">
        {links
          .filter((l) => !(hideControls && l.label === "Import collections"))
          .map((link) => (
            <Link
              key={link.to}
              to={link.to}
              activeOptions={{ exact: true }}
              className="rounded px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
              activeProps={{
                "aria-current": "page",
                className: "font-semibold",
              }}
            >
              {link.label}
            </Link>
          ))}
      </nav>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
