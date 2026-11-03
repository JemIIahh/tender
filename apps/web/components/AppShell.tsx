"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { walletStore } from "../lib/wallet";
import { Mark } from "./Mark";
import { Nav } from "./Nav";
import { PlatformStats } from "./PlatformStats";
import { PRIMARY, SECONDARY } from "./ui";

/** The pills of the top bar: the landing's, a little smaller so that both fit a phone. */
const BAR_PILL = "min-h-10 px-3.5 whitespace-nowrap sm:px-4";

function Wordmark() {
  return (
    <Link
      href="/"
      className="flex min-h-10 items-center gap-2.5 rounded-lg text-lg font-semibold tracking-tight text-bone"
    >
      <Mark />
      {/* On a phone the top bar has room for the mark only; the name is still the link's. */}
      <span className="max-sm:sr-only">Tender</span>
    </Link>
  );
}

/**
 * The frame of every page after the landing: a sidebar with the pages and a few live figures, a
 * top bar with "Post task" and the way to the wallet (the connected account, once a page has
 * connected one), and the page itself. On a phone the sidebar is a menu that the top bar opens,
 * over the page, and that closes when a page is chosen.
 *
 * The top bar comes first in the document, so that on a phone the open menu comes after the top bar
 * in the keyboard's order: the button that opened it, the wordmark and the two pills, then the
 * menu. While the menu is open the page under it is inert, so the keyboard cannot reach what the
 * menu covers; Escape closes it and gives the focus back to the button.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const menuId = useId();
  // The page the menu was opened on. It is open only there: choosing a page closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const menuButton = useRef<HTMLButtonElement>(null);
  // The wallet as far as this tab knows it, without looking for one: a page that needs the wallet
  // starts the store (lib/wallet.ts), and the board, say, does not load a wallet only for the top
  // bar. Until then, and while none is connected, the pill offers to connect one.
  const { accountId } = useSyncExternalStore(
    walletStore.subscribe,
    walletStore.getSnapshot,
    walletStore.getServerSnapshot,
  );

  // Escape closes the menu, as it closes any menu, and the focus goes back to the button that
  // opened it: the link it was on is no longer on the page.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenOn(null);
      menuButton.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // From laptop width up the sidebar is not a menu, and the page under it must not stay inert: a
  // menu left open when the window grows is closed.
  useEffect(() => {
    if (!open) return;
    const wide = window.matchMedia?.("(min-width: 64rem)");
    if (wide === undefined) return;
    if (wide.matches) {
      setOpenOn(null);
      return;
    }
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setOpenOn(null);
    };
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, [open]);

  return (
    <div className="app min-h-svh bg-ink text-bone lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:grid-rows-[auto_1fr]">
      <a
        href="#main"
        className="sr-only z-50 rounded-full bg-bone px-4 py-2 font-mono text-[11px] tracking-[0.12em] text-ink uppercase focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to the page
      </a>

      {/* From laptop width up, the sidebar's edge is the left border of the top bar and the page,
          which run the whole height of the page, where the sticky sidebar ends at the screen's. */}
      <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-line bg-ink/90 px-4 backdrop-blur-sm sm:px-8 lg:col-start-2 lg:row-start-1 lg:border-l">
        <button
          ref={menuButton}
          type="button"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpenOn(open ? null : pathname)}
          className="-ml-2 grid size-10 place-items-center rounded-lg text-bone lg:hidden"
        >
          <span className="sr-only">Menu</span>
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="size-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          >
            {open ? (
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
            ) : (
              <path d="M2 4.5h12M2 8h12M2 11.5h12" />
            )}
          </svg>
        </button>
        <div className="lg:hidden">
          <Wordmark />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/post" className={`${PRIMARY} ${BAR_PILL}`}>
            Post task
          </Link>
          {accountId === null ? (
            <Link href="/wallet" className={`${SECONDARY} ${BAR_PILL}`}>
              Connect wallet
            </Link>
          ) : (
            <Link
              href="/wallet"
              title={accountId}
              className={`${SECONDARY} ${BAR_PILL} max-w-[10rem] sm:max-w-60`}
            >
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-seal" />
              {/* The account as it is written: an account id is lower case. */}
              <span className="truncate text-xs tracking-normal normal-case">{accountId}</span>
            </Link>
          )}
        </div>
      </header>

      <aside
        id={menuId}
        data-open={open}
        className="fixed inset-x-0 top-16 bottom-0 z-20 hidden flex-col gap-8 overflow-y-auto border-t border-line bg-ink px-4 pt-6 pb-8 data-[open=true]:flex sm:px-8 lg:sticky lg:top-0 lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:flex lg:h-svh lg:border-t-0 lg:px-3 lg:pt-0 lg:pb-6"
      >
        <div className="hidden h-16 shrink-0 items-center px-2 lg:flex">
          <Wordmark />
        </div>
        <Nav />
        <div className="mt-auto">
          <PlatformStats />
        </div>
      </aside>

      {/* Under the open menu, the page is out of reach of the keyboard and the pointer alike. */}
      <main
        id="main"
        inert={open}
        className="min-w-0 border-line px-4 pt-8 pb-16 sm:px-8 lg:col-start-2 lg:row-start-2 lg:border-l"
      >
        {children}
      </main>
    </div>
  );
}
