import { Link, useLocation } from "@tanstack/react-router";
import { Database, Puzzle, ScrollText, Settings, Shield } from "lucide-react";
import type { ReactNode } from "react";
import { useExtensions } from "../app/context";
import { useSettings } from "../settings/use-settings";
import { Logo } from "./Logo";

const iconProps = { size: 15, strokeWidth: 1.75 };

const links = [
  {
    to: "/collections",
    label: "Collections",
    icon: <Database {...iconProps} />,
  },
  {
    to: "/collections/$collectionId",
    params: { collectionId: "hbc_3142635823" },
    label: "Superusers",
    icon: <Shield {...iconProps} />,
  },
  { to: "/logs", label: "Logs", icon: <ScrollText {...iconProps} /> },
  { to: "/settings", label: "Settings", icon: <Settings {...iconProps} /> },
] as const;

const SUPERUSERS = "/collections/hbc_3142635823";

const item =
  "flex items-center gap-2 rounded-control px-2.5 py-1.5 text-muted hover:bg-hover hover:text-text";
const active = "bg-hover font-medium text-text";

function Label({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <>
      {icon}
      {children}
    </>
  );
}

export function Sidebar() {
  const { pages, links: extensionLinks } = useExtensions();
  const { pathname } = useLocation();
  const appName = (useSettings().data?.meta as { appName?: string } | undefined)
    ?.appName;
  const onSuperusers =
    pathname === SUPERUSERS || pathname === "/collections/_superusers";
  return (
    <nav
      aria-label="Main"
      className="sticky top-0 flex h-dvh w-48 shrink-0 flex-col gap-0.5 border-r border-line bg-glass p-2 backdrop-blur-(--hb-glass-blur) backdrop-saturate-150"
    >
      <div className="mb-2 flex h-9 items-center gap-2 px-2">
        <Logo />
        <span className="text-[15px] font-semibold tracking-tight text-text">
          {appName || "heybe"}
        </span>
      </div>
      {links.map((link) => (
        <Link
          key={link.label}
          to={link.to}
          params={"params" in link ? link.params : undefined}
          className={item}
          activeProps={{ "aria-current": "page", className: active }}
          activeOptions={{
            exact:
              link.label === "Superusers" ||
              (link.label === "Collections" && onSuperusers),
          }}
        >
          <Label icon={link.icon}>{link.label}</Label>
        </Link>
      ))}
      {(pages.length > 0 || extensionLinks.length > 0) && (
        <div className="mt-3 flex flex-col gap-0.5">
          <h2 className="px-2.5 text-xs font-medium uppercase text-faint">
            Extensions
          </h2>
          {pages.map((page) => (
            <Link
              key={page.path}
              to="/ext/$"
              params={{ _splat: page.path }}
              className={item}
              activeProps={{ "aria-current": "page", className: active }}
            >
              <Label icon={<Puzzle {...iconProps} />}>{page.title}</Label>
            </Link>
          ))}
          {extensionLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className={item}
            >
              <Label icon={<Puzzle {...iconProps} />}>{link.label}</Label>
            </a>
          ))}
        </div>
      )}
    </nav>
  );
}
