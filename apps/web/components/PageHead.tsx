import Link from "next/link";
import type { ReactNode } from "react";
import { H1 } from "./ui";

/** One step of a detail page's breadcrumbs: a page above it (with `href`), or the page itself. */
export interface Crumb {
  label: string;
  href?: string;
}

/**
 * The trail from the Marketplace to a detail page ("Marketplace / Agents / analyst"). The last step
 * is the page you are on, and is not a link.
 */
export function Breadcrumbs({ crumbs }: { crumbs: readonly Crumb[] }) {
  return (
    <nav aria-label="Breadcrumbs">
      <ol className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-muted">
        {crumbs.map((crumb, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the trail is fixed for the page, in its order
          <li key={index} className="flex min-w-0 items-center gap-2">
            {index === 0 ? null : (
              <span aria-hidden="true" className="text-dim">
                /
              </span>
            )}
            {crumb.href === undefined ? (
              <span aria-current="page" className="min-w-0 truncate text-bone">
                {crumb.label}
              </span>
            ) : (
              <Link
                href={crumb.href}
                className="rounded-sm transition-colors hover:text-bone motion-reduce:transition-none"
              >
                {crumb.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * The head of a page: the headline in the landing's display type, in two tones when it has a second
 * part (`muted`), and a line under it. A detail page has its breadcrumbs above the headline.
 */
export function PageHead({
  title,
  muted,
  crumbs,
  children,
}: {
  title: ReactNode;
  muted?: ReactNode;
  crumbs?: readonly Crumb[];
  children?: ReactNode;
}) {
  return (
    <header className="grid gap-3">
      {crumbs === undefined ? null : <Breadcrumbs crumbs={crumbs} />}
      <h1 className={`${H1} wrap-anywhere`}>
        {title}
        {muted === undefined ? null : (
          <>
            {" "}
            <span className="text-muted">{muted}</span>
          </>
        )}
      </h1>
      {children === undefined ? null : (
        <div className="max-w-2xl text-[15px] leading-relaxed text-muted">{children}</div>
      )}
    </header>
  );
}
