"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

// Every page of the app, in the groups of the sidebar (components/AppShell.tsx), so that a task
// that adds a page does not have to touch the shell. Until it does, its link leads to Next's own
// "not found" page.

type Icon = "market" | "post" | "agents" | "wallet" | "telegram";

interface Item {
  href: string;
  label: string;
  icon: Icon;
}

const GROUPS: ReadonlyArray<{ title: string | null; items: readonly Item[] }> = [
  {
    title: null,
    items: [
      { href: "/tasks", label: "Marketplace", icon: "market" },
      { href: "/agents", label: "Agents", icon: "agents" },
    ],
  },
  { title: "Tasks", items: [{ href: "/post", label: "Post a task", icon: "post" }] },
  {
    title: "Account",
    items: [
      { href: "/wallet", label: "Wallet", icon: "wallet" },
      { href: "/telegram", label: "Telegram", icon: "telegram" },
    ],
  },
];

/** Whether `pathname` is the page `href` leads to, or a page under it. */
function isCurrent(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The small line drawings beside the links: decoration, the words are the links' names. */
const ICONS: Record<Icon, ReactNode> = {
  market: (
    <>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </>
  ),
  post: (
    <>
      <path d="M3 13l.6-2.7L10.4 3.5a1.4 1.4 0 0 1 2 0l.1.1a1.4 1.4 0 0 1 0 2L5.7 12.4z" />
      <path d="M9.3 4.6l2.1 2.1" />
    </>
  ),
  agents: (
    <>
      <circle cx="8" cy="5.5" r="2.6" />
      <path d="M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" />
    </>
  ),
  wallet: (
    <>
      <rect x="2" y="4" width="12" height="9" rx="1.6" />
      <path d="M2 6.5h9.5M10.5 9.6h1.5" />
    </>
  ),
  telegram: <path d="M14 2.5L1.8 7.4l4.4 1.5 1.6 4.6 2.3-3 3 2.2z" />,
};

function NavIcon({ icon }: { icon: Icon }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      {ICONS[icon]}
    </svg>
  );
}

/** The app's pages, grouped as the sidebar shows them, with the one you are on marked. */
export function Nav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="grid gap-6">
      {GROUPS.map((group) => (
        <div key={group.title ?? "top"} className="grid gap-1">
          {group.title === null ? null : (
            <p className="px-3 pb-1 font-mono text-[10.5px] tracking-[0.16em] text-dim uppercase">
              {group.title}
            </p>
          )}
          <ul className="grid gap-1">
            {group.items.map(({ href, label, icon }) => (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={isCurrent(href, pathname) ? "page" : undefined}
                  className="flex min-h-10 items-center gap-3 rounded-xl px-3 text-[15px] text-muted transition-colors hover:bg-raised/60 hover:text-bone motion-reduce:transition-none aria-[current=page]:bg-raised aria-[current=page]:text-bone"
                >
                  <NavIcon icon={icon} />
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
