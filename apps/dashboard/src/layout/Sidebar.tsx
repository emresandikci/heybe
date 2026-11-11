import { Link } from "@tanstack/react-router";
import { useExtensions } from "../app/context";

const links = [
  { to: "/collections", label: "Collections" },
  {
    to: "/collections/$collectionId",
    params: { collectionId: "pbc_3142635823" },
    label: "Superusers",
  },
  { to: "/logs", label: "Logs" },
  { to: "/settings", label: "Settings" },
] as const;

export function Sidebar() {
  const { pages, links: extensionLinks } = useExtensions();
  return (
    <nav
      aria-label="Main"
      className="flex w-48 shrink-0 flex-col gap-1 border-r border-slate-200 p-3 dark:border-slate-700"
    >
      {links.map((link) => (
        <Link
          key={link.label}
          to={link.to}
          params={"params" in link ? link.params : undefined}
          className="rounded px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
          activeProps={{ "aria-current": "page", className: "font-semibold" }}
        >
          {link.label}
        </Link>
      ))}
      {(pages.length > 0 || extensionLinks.length > 0) && (
        <div className="mt-3 flex flex-col gap-1">
          <h2 className="px-3 text-xs font-semibold uppercase text-slate-500">
            Extensions
          </h2>
          {pages.map((page) => (
            <Link
              key={page.path}
              to="/ext/$"
              params={{ _splat: page.path }}
              className="rounded px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
              activeProps={{
                "aria-current": "page",
                className: "font-semibold",
              }}
            >
              {page.title}
            </Link>
          ))}
          {extensionLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {link.label}
            </a>
          ))}
        </div>
      )}
    </nav>
  );
}
