import { Fragment, type ReactNode } from "react";
import { Link, Outlet } from "@tanstack/react-router";
import {
  Archive,
  Clock,
  FileDown,
  FileUp,
  HardDrive,
  KeyRound,
  Mail,
  SlidersHorizontal,
  Terminal,
} from "lucide-react";
import { useHideControls } from "./use-settings";

const iconProps = { size: 15, strokeWidth: 1.75 };

const groups: {
  title: string;
  links: { to: string; label: string; icon: ReactNode }[];
}[] = [
  {
    title: "System",
    links: [
      {
        to: "/settings",
        label: "Application",
        icon: <SlidersHorizontal {...iconProps} />,
      },
      { to: "/settings/mail", label: "Mail", icon: <Mail {...iconProps} /> },
      {
        to: "/settings/storage",
        label: "File storage",
        icon: <HardDrive {...iconProps} />,
      },
      {
        to: "/settings/backups",
        label: "Backups",
        icon: <Archive {...iconProps} />,
      },
      { to: "/settings/crons", label: "Crons", icon: <Clock {...iconProps} /> },
    ],
  },
  {
    title: "Sync",
    links: [
      {
        to: "/settings/export-collections",
        label: "Export collections",
        icon: <FileDown {...iconProps} />,
      },
      {
        to: "/settings/import-collections",
        label: "Import collections",
        icon: <FileUp {...iconProps} />,
      },
    ],
  },
  {
    title: "Authentication",
    links: [
      {
        to: "/settings/auth-providers",
        label: "Auth providers",
        icon: <KeyRound {...iconProps} />,
      },
    ],
  },
  {
    title: "Debug",
    links: [
      { to: "/settings/sql", label: "SQL", icon: <Terminal {...iconProps} /> },
    ],
  },
];

export function SettingsLayout() {
  const hideControls = useHideControls();
  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <nav
        aria-label="Settings"
        className="flex flex-col gap-0.5 md:sticky md:top-0 md:w-48 md:shrink-0 md:self-start"
      >
        {groups.map((group, i) => (
          <Fragment key={group.title}>
            <h2
              className={`px-2.5 pb-1 text-xs font-medium uppercase text-faint ${i > 0 ? "mt-3" : ""}`}
            >
              {group.title}
            </h2>
            {group.links
              .filter(
                (l) => !(hideControls && l.label === "Import collections"),
              )
              .map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  activeOptions={{ exact: true }}
                  className="flex items-center gap-2 rounded-control px-2.5 py-1.5 text-muted hover:bg-hover/50 hover:text-text focus-visible:outline-2 focus-visible:outline-focus"
                  activeProps={{
                    "aria-current": "page",
                    className: "bg-hover font-medium text-text hover:bg-hover",
                  }}
                >
                  {link.icon}
                  {link.label}
                </Link>
              ))}
          </Fragment>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  );
}
