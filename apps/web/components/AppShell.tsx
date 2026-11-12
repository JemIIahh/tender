"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { MCP_DOCS_URL, REPO_URL, SKILL_URL } from "../lib/links";
import { restoreSidebar, setRail, sidebarStore } from "../lib/sidebar";
import { walletStore } from "../lib/wallet";
import { AccountGroup, BAR_PILL } from "./AccountPill";
import { ConnectChooser } from "./ConnectChooser";
import { Mark } from "./Mark";
import { Nav, type TipHandlers } from "./Nav";
import { SidebarLive } from "./SidebarLive";
import { PRIMARY } from "./ui";

/** Laptop width, from which the sidebar is a sidebar (and can be the rail) and not a menu. */
const WIDE = "(min-width: 64rem)";

/** Whether the window is laptop width or more. A browser that cannot say is taken to be. */
function isWide(): boolean {
  return window.matchMedia?.(WIDE)?.matches ?? true;
}

/** The kinds of input that take no typing: in any other, ⌘B is the field's and not the page's. */
const NOT_TYPED = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** Whether `element` is where a person types: a text field, a text area or editable text. */
function isTyping(element: Element | null): boolean {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) return !NOT_TYPED.has(element.type);
  return element instanceof HTMLElement && element.isContentEditable === true;
}

/** The shortcut as this computer writes it: ⌘B on a Mac, an iPhone or an iPad, Ctrl+B elsewhere. */
function shortcutText(): string {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  return /mac|iphone|ipad/i.test(platform) ? "⌘B" : "Ctrl+B";
}

/** Whether the focus that `element` just took is the keyboard's (a click's shows no tooltip). */
function focusIsVisible(element: HTMLElement): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

/**
 * A tooltip of the sidebar: a link's name beside its icon on the rail, or what the toggle does
 * under it. It is placed by the element it is for, fixed on the screen, so the sidebar's edge does
 * not cut it off. `label` null is the toggle's, whose words follow the sidebar's state.
 */
interface Tip {
  label: string | null;
  side: "right" | "below";
  left: number;
  top: number;
  /** The page it was shown on: a page chosen from the rail takes it away. */
  on: string;
}

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

/** The toggle's drawing: a window with a panel down its left side. */
function PanelIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-[18px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    >
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.8" />
      <path d="M6 2.8v10.4" />
    </svg>
  );
}

/** How the parts that come and go with the rail fade: with the width, at once without motion. */
const FADE = "transition-[opacity,visibility] duration-200 motion-reduce:transition-none";

/**
 * The frame of every page after the landing: a sidebar with the pages and, pinned under them, the
 * Live block (components/SidebarLive: a few of the platform's figures and the way to Metrics); a
 * top bar with "Post task" and the account group (components/AccountPill: whether the index is up
 * to date, the network, and the way to the wallet, which is the connected account once a page has
 * connected one); and the page itself. On a phone the sidebar is a menu that the top bar opens,
 * over the page, and that closes when a page is chosen.
 *
 * From laptop width up, the button at the head of the sidebar, or ⌘B (Ctrl+B), makes the sidebar a
 * narrow rail of icons and back (lib/sidebar.ts keeps the choice). On the rail each icon has its
 * name in a tooltip, and Tender's mark moves to the top bar. The shortcut is left to a text field
 * that has the focus, where ⌘B is the field's.
 *
 * The top bar comes first in the document, so that on a phone the open menu comes after the top bar
 * in the keyboard's order: the button that opened it, the wordmark and the pills, then the menu.
 * While the menu is open the page under it is inert, so the keyboard cannot reach what the menu
 * covers; Escape closes it and gives the focus back to the button.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const menuId = useId();
  // The page the menu was opened on. It is open only there: choosing a page closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const menuButton = useRef<HTMLButtonElement>(null);
  const toggleButton = useRef<HTMLButtonElement>(null);
  // The two places of the wordmark: the sidebar's head, and the top bar, where it is on the rail.
  const sideMark = useRef<HTMLDivElement>(null);
  const barMark = useRef<HTMLDivElement>(null);
  // The wallet as this tab knows it. The shell starts the store once it is in the browser, so that
  // every page takes up the wallet of an earlier visit (silently: a restore opens no window); the
  // wallet library loads then, after the page. Until the store knows (`ready`), the pill is a
  // placeholder, so that a page that is about to show the account never shows Connect first.
  const { ready, accountId, keyHolder } = useSyncExternalStore(
    walletStore.subscribe,
    walletStore.getSnapshot,
    walletStore.getServerSnapshot,
  );
  useEffect(() => {
    void walletStore.start();
  }, []);
  // Whether the sidebar is the rail. The page's look follows the root element's attribute in CSS;
  // this is for the toggle's state and words.
  const rail = useSyncExternalStore(
    sidebarStore.subscribe,
    sidebarStore.getSnapshot,
    sidebarStore.getServerSnapshot,
  );

  // A page loaded fresh has the choice already (the head's script); one reached from the landing
  // by a link gets it here, before it is drawn.
  useLayoutEffect(() => {
    restoreSidebar();
  }, []);

  const toggle = useCallback(() => {
    const next = !sidebarStore.getSnapshot();
    // The wordmark that is about to be put away may hold the focus: it goes to the toggle, which
    // stays where it is.
    const leaving = next ? sideMark.current : barMark.current;
    if (leaving?.contains(document.activeElement)) toggleButton.current?.focus();
    setRail(next);
  }, []);

  // ⌘B (Ctrl+B) from anywhere on the page, but not in a text field, where it is the field's; and
  // only from laptop width up, where there is a sidebar to make narrow.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (typeof event.key !== "string" || event.key.toLowerCase() !== "b") return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.defaultPrevented || isTyping(document.activeElement) || !isWide()) return;
      event.preventDefault();
      toggle();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggle]);

  // The tooltips. One is shown at a time. It goes a moment after the pointer leaves, so that the
  // pointer can move onto it, and at once on Escape.
  const [tip, setTip] = useState<Tip | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  const keepTip = useCallback(() => clearTimeout(hideTimer.current), []);
  const hideTip = useCallback(() => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setTip(null), 120);
  }, []);
  const showTip = useCallback(
    (element: HTMLElement, label: string | null, side: Tip["side"]) => {
      clearTimeout(hideTimer.current);
      const box = element.getBoundingClientRect();
      setTip(
        side === "right"
          ? // Clear of the rail's edge, which is 12px right of an icon's box.
            { label, side, left: box.right + 16, top: box.top + box.height / 2, on: pathname }
          : { label, side, left: box.left, top: box.bottom + 8, on: pathname },
      );
    },
    [pathname],
  );
  const tipHandlers = useCallback(
    (label: string | null, side: Tip["side"]): TipHandlers => {
      // A link's name is shown only on the rail, where the link is an icon; the toggle's always.
      const wanted = () => label === null || (sidebarStore.getSnapshot() && isWide());
      return {
        onPointerEnter: (event) => {
          if (event.pointerType !== "touch" && wanted()) showTip(event.currentTarget, label, side);
        },
        onPointerLeave: hideTip,
        onFocus: (event) => {
          if (wanted() && focusIsVisible(event.currentTarget)) {
            showTip(event.currentTarget, label, side);
          }
        },
        onBlur: hideTip,
      };
    },
    [showTip, hideTip],
  );
  const linkTip = useCallback((label: string) => tipHandlers(label, "right"), [tipHandlers]);
  // A link's tooltip is gone once the sidebar is wide again, or another page is chosen.
  const shownTip = tip !== null && tip.on === pathname && (tip.label === null || rail) ? tip : null;

  useEffect(() => {
    if (shownTip === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTip(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [shownTip]);

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
    const wide = window.matchMedia?.(WIDE);
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
    <div className="app min-h-svh bg-ink text-bone lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:transition-[grid-template-columns] lg:duration-200 lg:ease-[cubic-bezier(0.32,0.72,0,1)] lg:motion-reduce:transition-none lg:rail:grid-cols-[4rem_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only z-50 rounded-full bg-bone px-4 py-2 text-[13px] font-medium text-ink focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to the page
      </a>

      {/* From laptop width up, the sidebar's edge is the left border of the top bar and the page,
          which run the whole height of the page, where the sticky sidebar ends at the screen's. */}
      <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-line px-4 sm:px-8 lg:col-start-2 lg:row-start-1 lg:border-l">
        {/* The bar's frosted ground is a layer of its own, behind its contents. On the bar itself,
            the blur (a backdrop filter) would make the bar the box that a fixed part inside it is
            placed in, and the Live panel, fixed under the bar on a phone, would follow the bar
            instead of the screen. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-ink/90 backdrop-blur-sm"
        />
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
        {/* The wordmark is here on a phone, and on a laptop while the sidebar is the rail. */}
        <div ref={barMark} data-testid="bar-wordmark" className="lg:hidden lg:rail:block">
          <Wordmark />
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <Link href="/post" className={`${PRIMARY} ${BAR_PILL}`}>
            Post task
          </Link>
          <AccountGroup ready={ready} accountId={accountId} login={keyHolder?.login} />
        </div>
      </header>

      <aside
        id={menuId}
        data-open={open}
        className="fixed inset-x-0 top-16 bottom-0 z-20 hidden flex-col gap-4 overflow-hidden border-t border-line bg-ink px-4 pt-4 pb-5 data-[open=true]:flex sm:px-8 lg:sticky lg:top-0 lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:flex lg:h-svh lg:border-t-0 lg:px-3 lg:pt-0 lg:pb-4"
      >
        <div className="hidden h-16 shrink-0 items-center gap-1.5 lg:flex">
          {/* Its name is what it controls, and stays the same as it is pressed; `aria-expanded` says
              whether the sidebar is wide now, and the tooltip says what a press does. */}
          <button
            ref={toggleButton}
            type="button"
            aria-label="Sidebar"
            aria-expanded={!rail}
            aria-controls={menuId}
            aria-keyshortcuts="Meta+B Control+B"
            onClick={toggle}
            {...tipHandlers(null, "below")}
            className="grid size-10 shrink-0 place-items-center rounded-xl text-muted transition-colors hover:bg-raised/60 hover:text-bone motion-reduce:transition-none"
          >
            <PanelIcon />
          </button>
          {/* On the rail it is cut off by its own box, so it never makes the sidebar wider than the
              rail; the padding leaves room for the focus ring. */}
          <div
            ref={sideMark}
            data-testid="side-wordmark"
            className={`-m-1.5 min-w-0 overflow-hidden p-1.5 ${FADE} lg:rail:invisible lg:rail:opacity-0`}
          >
            <Wordmark />
          </div>
        </div>
        {/* The links scroll on their own when the window is short; the Live block stays in view. The
            gutter leaves room for a link's focus ring, which the scrolling box would cut off. */}
        <div className="-mx-1.5 min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1.5 py-1">
          <Nav tip={linkTip} />
        </div>
        <SidebarLive tip={linkTip} />
      </aside>

      {/* Under the open menu, the page is out of reach of the keyboard and the pointer alike. */}
      <main
        id="main"
        inert={open}
        className="min-w-0 border-line px-4 pt-8 pb-16 sm:px-8 lg:col-start-2 lg:row-start-2 lg:border-l"
      >
        {children}
        <footer className="mx-auto mt-20 flex w-full max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-1 border-t border-line pt-5 text-[13px] text-muted">
          {[
            [SKILL_URL, "Agent guide"],
            [MCP_DOCS_URL, "MCP server docs"],
            [REPO_URL, "Source code"],
          ].map(([href, label]) => (
            <a
              key={label}
              href={href}
              className="inline-flex min-h-10 items-center transition-colors hover:text-bone motion-reduce:transition-none"
            >
              {label}
            </a>
          ))}
        </footer>
      </main>

      {/* The tooltip says again what a screen reader is told already, so it is hidden from one: a
          link's name, or for the toggle what a press does, which its name, its state
          (`aria-expanded`) and its shortcut (`aria-keyshortcuts`) say. */}
      {shownTip === null ? null : (
        <div
          aria-hidden="true"
          data-testid="sidebar-tip"
          onPointerEnter={keepTip}
          onPointerLeave={hideTip}
          style={{ left: shownTip.left, top: shownTip.top }}
          className={`fixed z-50 flex items-center gap-2.5 rounded-lg border border-line bg-raised px-2.5 py-1.5 text-[13px] whitespace-nowrap text-bone shadow-lg shadow-black/50 ${shownTip.side === "right" ? "-translate-y-1/2" : ""}`}
        >
          {shownTip.label ?? (rail ? "Show sidebar" : "Hide sidebar")}
          {shownTip.label === null ? (
            <span className="font-mono text-[11px] text-muted">{shortcutText()}</span>
          ) : null}
        </div>
      )}

      {/* Connect's window: the email and Google login and the NEAR wallets (lib/chooser.ts). */}
      <ConnectChooser />
    </div>
  );
}
