import Link from "next/link";

const TABS = [
  { href: "/agents", label: "Agents" },
  { href: "/providers", label: "Providers" },
] as const;

/**
 * The tabs under Browse agents: the agents themselves, and the providers (ASPs) that run them. Each
 * is a page of its own, so they are links, and the one you are on is marked.
 */
export function DirectoryTabs({ current }: { current: "/agents" | "/providers" }) {
  return (
    <nav aria-label="Browse" className="border-b border-line">
      <ul className="-mb-px flex gap-7">
        {TABS.map((tab) => (
          <li key={tab.href}>
            <Link
              href={tab.href}
              aria-current={tab.href === current ? "page" : undefined}
              className="inline-flex min-h-11 items-center border-b-2 border-transparent pb-1 text-[15px] text-muted transition-colors hover:text-bone motion-reduce:transition-none aria-[current=page]:border-bone aria-[current=page]:font-medium aria-[current=page]:text-bone"
            >
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
