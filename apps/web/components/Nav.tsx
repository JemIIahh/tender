"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { FocusEvent, PointerEvent, ReactNode } from "react";

// Every page of the app, in the groups of the sidebar (components/AppShell.tsx), so that a task
// that adds a page does not have to touch the shell. The Marketplace is first and alone; then the
// tasks, the agents, the account, and the docs. Providers is a tab of Browse agents, Telegram is a
// row of Settings, and Metrics is behind the sidebar's Live block: each still has its page, which
// marks the link it is under.
//
// From laptop width up the sidebar can be a narrow rail of icons (lib/sidebar.ts). The rail's look
// is all CSS, on the `rail:` variant: each link keeps its icon where it was, its words fade out,
// and a group's title gives way to a line. A link's name is its label in either state.

type Icon =
  | "market"
  | "activity"
  | "post"
  | "tasks"
  | "browse"
  | "services"
  | "add"
  | "mine"
  | "earnings"
  | "wallet"
  | "settings"
  | "how";

interface Item {
  href: string;
  label: string;
  icon: Icon;
}

const GROUPS: ReadonlyArray<{ title: string | null; items: readonly Item[] }> = [
  {
    title: null,
    items: [{ href: "/tasks", label: "Marketplace", icon: "market" }],
  },
  {
    title: "Tasks",
    items: [
      { href: "/post", label: "Post a task", icon: "post" },
      { href: "/my-tasks", label: "My tasks", icon: "tasks" },
    ],
  },
  {
    title: "Agents",
    items: [
      { href: "/agents", label: "Browse agents", icon: "browse" },
      { href: "/services", label: "Services", icon: "services" },
      { href: "/my-agents/new", label: "Add an agent", icon: "add" },
      { href: "/my-agents", label: "My agents", icon: "mine" },
    ],
  },
  {
    title: "Account",
    items: [
      { href: "/activity", label: "Activity", icon: "activity" },
      { href: "/earnings", label: "Earnings", icon: "earnings" },
      { href: "/wallet", label: "Wallet", icon: "wallet" },
      { href: "/settings", label: "Settings", icon: "settings" },
    ],
  },
  {
    title: "Docs",
    items: [{ href: "/how-it-works", label: "How it works", icon: "how" }],
  },
];

const HREFS = GROUPS.flatMap((group) => group.items.map((item) => item.href));

/** Pages with no link of their own, and the link they are under. */
const UNDER: Readonly<Record<string, string>> = {
  "/providers": "/agents",
  "/telegram": "/settings",
};

/** Whether `pathname` is the page `href`, or under it. */
const within = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

/**
 * The link of the page you are on: the one whose page `pathname` is, or is under, and of those the
 * longest, so that adding an agent (`/my-agents/new`) is "Add an agent" and not "My agents" too. A
 * page with no link of its own marks the link it is under (a provider's page, Browse agents).
 */
export function currentHref(pathname: string): string | undefined {
  const own = HREFS.filter((href) => within(pathname, href)).sort((a, b) => b.length - a.length)[0];
  if (own !== undefined) return own;
  return Object.entries(UNDER).find(([page]) => within(pathname, page))?.[1];
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
  // A pulse: what is happening now.
  activity: <path d="M1.5 8.5h2.8l1.9-4.7 3.4 8.4 1.9-3.7h3" />,
  post: (
    <>
      <path d="M3 13l.6-2.7L10.4 3.5a1.4 1.4 0 0 1 2 0l.1.1a1.4 1.4 0 0 1 0 2L5.7 12.4z" />
      <path d="M9.3 4.6l2.1 2.1" />
    </>
  ),
  // A list with two items ticked.
  tasks: (
    <>
      <path d="M2.3 4.3l1.3 1.3 2.3-2.4M2.3 10.3l1.3 1.3 2.3-2.4" />
      <path d="M8.4 4.4h5.3M8.4 10.4h5.3" />
    </>
  ),
  browse: (
    <>
      <circle cx="7" cy="7" r="4.3" />
      <path d="M10.2 10.2l3.3 3.3" />
    </>
  ),
  add: (
    <>
      <circle cx="6.5" cy="5.4" r="2.5" />
      <path d="M2 13.5c.5-2.4 2.3-3.9 4.5-3.9 1 0 1.9.3 2.6.8" />
      <path d="M12.5 9.2v4.6M10.2 11.5h4.6" />
    </>
  ),
  // A storefront: an awning over a counter and a door.
  services: (
    <>
      <path d="M2.5 6.2L3.6 2.8h8.8l1.1 3.4c0 1-.8 1.8-1.8 1.8s-1.8-.8-1.8-1.8c0 1-.8 1.8-1.8 1.8s-1.8-.8-1.8-1.8c0 1-.8 1.8-1.8 1.8s-1.8-.8-1.8-1.8z" />
      <path d="M3.4 8v5.5h9.2V8M6.6 13.5v-3h2.8v3" />
    </>
  ),
  mine: (
    <>
      <circle cx="6" cy="5.5" r="2.3" />
      <path d="M1.8 13c.5-2.3 2.2-3.6 4.2-3.6s3.7 1.3 4.2 3.6" />
      <path d="M10.6 3.4a2.3 2.3 0 0 1 0 4.3M12 9.6c1.2.5 2 1.6 2.3 3.4" />
    </>
  ),
  earnings: (
    <>
      <path d="M2.5 13.5h11" />
      <path d="M4 11V8.5M7 11V6M10 11V7.5M13 11V4" />
    </>
  ),
  wallet: (
    <>
      <rect x="2" y="4" width="12" height="9" rx="1.6" />
      <path d="M2 6.5h9.5M10.5 9.6h1.5" />
    </>
  ),
  // Two sliders.
  settings: (
    <>
      <path d="M2.3 4.8h4M9.7 4.8h4M2.3 11.2h6.4M12.1 11.2h1.6" />
      <circle cx="8" cy="4.8" r="1.7" />
      <circle cx="10.4" cy="11.2" r="1.7" />
    </>
  ),
  // A question in a circle.
  how: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.2 6.3a1.9 1.9 0 0 1 3.7.5c0 1.3-1.9 1.6-1.9 2.8" />
      <path d="M8 11.5v.1" />
    </>
  ),
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

/** What a link does to show its name beside it, while the sidebar is the rail (AppShell). */
export interface TipHandlers {
  onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
}

/** How the words of the rail fade: with the width, and at once when motion is not wanted. */
const FADE = "transition-opacity duration-200 motion-reduce:transition-none";

/** One link of the sidebar: its icon, and its words, which fade on the rail; its name either way. */
function NavLink({
  item: { href, label, icon },
  current,
  tip,
}: {
  item: Item;
  current: string | undefined;
  tip?: (label: string) => TipHandlers;
}) {
  return (
    <Link
      href={href}
      // Every page of the sidebar is fetched ahead as its link comes into view (a production build
      // only): each is a static page, so it comes whole, and a press on it shows it at once.
      prefetch
      aria-label={label}
      aria-current={href === current ? "page" : undefined}
      {...tip?.(label)}
      className={`flex min-h-9 items-center gap-3 overflow-hidden rounded-xl px-3 text-[15px] text-muted transition-colors hover:bg-raised/60 hover:text-bone motion-reduce:transition-none aria-[current=page]:bg-raised aria-[current=page]:text-bone`}
    >
      <NavIcon icon={icon} />
      <span className={`whitespace-nowrap ${FADE} lg:rail:opacity-0`}>{label}</span>
    </Link>
  );
}

/**
 * The app's pages, grouped as the sidebar shows them, with the one you are on marked. `tip` gives
 * each link what it needs to show its name in a tooltip on the rail.
 */
export function Nav({ tip }: { tip?: (label: string) => TipHandlers } = {}) {
  const current = currentHref(usePathname());
  return (
    // One column that may be narrower than the words in it (`grid-cols-1` is minmax(0, 1fr)): on
    // the rail a link is as wide as the rail, and the words it holds are cut off, not the rail.
    <nav aria-label="Main" className="grid grid-cols-1 content-start gap-4">
      {GROUPS.map((group) => (
        <div key={group.title ?? "top"} className="grid grid-cols-1 gap-1">
          {group.title === null ? null : (
            // On the rail the title gives way to a line, midway between the groups. The title keeps
            // its height, so that no icon moves up or down, and its words stay for a screen
            // reader, which reads the group by them.
            <div className="relative overflow-hidden">
              <p
                className={`px-3 pb-1.5 text-[11px] font-medium tracking-[0.08em] whitespace-nowrap text-muted uppercase ${FADE} lg:rail:opacity-0`}
              >
                {group.title}
              </p>
              <span
                aria-hidden="true"
                className={`absolute inset-x-1.5 top-0 hidden h-px bg-line opacity-0 lg:block ${FADE} lg:rail:opacity-100`}
              />
            </div>
          )}
          <ul className="grid grid-cols-1 gap-0.5">
            {group.items.map((item) => (
              <li key={item.href}>
                <NavLink item={item} current={current} tip={tip} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
