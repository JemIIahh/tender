"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Every page of the app, so that a task that adds one does not have to touch this file. Until it
// does, its link leads to Next's own "not found" page.
const LINKS = [
  { href: "/", label: "Tasks" },
  { href: "/agents", label: "Agents" },
  { href: "/post", label: "Post a task" },
  { href: "/wallet", label: "Wallet" },
  { href: "/telegram", label: "Telegram" },
] as const;

/** Whether `pathname` is the page `href` leads to, or a page under it. */
function isCurrent(href: string, pathname: string): boolean {
  // A task's page, /tasks/7, belongs to the board.
  if (href === "/") return pathname === "/" || pathname.startsWith("/tasks/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="border-b border-neutral-300">
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-6 px-4">
        <Link href="/" className="py-3 text-lg font-semibold">
          Tender
        </Link>
        <nav aria-label="Main">
          <ul className="flex flex-wrap gap-x-3">
            {LINKS.map(({ href, label }) => (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={isCurrent(href, pathname) ? "page" : undefined}
                  className="inline-block py-3 underline-offset-4 aria-[current=page]:font-semibold aria-[current=page]:underline"
                >
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </header>
  );
}
