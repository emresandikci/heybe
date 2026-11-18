import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";

const DOCS_URL = "https://github.com/emresandikci/heybe#readme";

interface Crumb {
  label: string;
  to?: string;
  params?: Record<string, string>;
}

export function Page({
  crumbs,
  actions,
  width = "form",
  footer,
  children,
}: {
  crumbs: Crumb[];
  actions?: ReactNode;
  width?: "form" | "full";
  footer?: ReactNode;
  children: ReactNode;
}) {
  const column = `mx-auto w-full ${width === "form" ? "max-w-240" : ""}`;
  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className={`${column} flex flex-1 flex-col gap-4`}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h1 className="flex min-w-0 items-center text-lg font-semibold">
            {crumbs.map((crumb, i) => {
              const last = i === crumbs.length - 1;
              return (
                <Fragment key={i}>
                  {i > 0 && (
                    <span className="shrink-0 whitespace-pre text-faint">
                      {" / "}
                    </span>
                  )}
                  {crumb.to && !last ? (
                    <Link
                      to={crumb.to as string}
                      params={crumb.params}
                      className="shrink-0 rounded-control text-muted hover:text-text"
                    >
                      {crumb.label}
                    </Link>
                  ) : (
                    <span
                      aria-current={last ? "page" : undefined}
                      title={last ? crumb.label : undefined}
                      className={
                        last ? "min-w-0 truncate" : "shrink-0 text-muted"
                      }
                    >
                      {crumb.label}
                    </span>
                  )}
                </Fragment>
              );
            })}
          </h1>
          {actions && (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          )}
        </div>
        {children}
      </div>
      <footer
        className={`${column} flex items-center justify-between gap-4 border-t border-line pt-3 text-xs text-faint`}
      >
        <div>{footer}</div>
        <div className="flex items-center gap-3">
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="hover:text-text"
          >
            Docs
          </a>
          <span>Heybe v{__HEYBE_VERSION__}</span>
        </div>
      </footer>
    </div>
  );
}
