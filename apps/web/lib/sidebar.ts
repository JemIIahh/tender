// Whether the app's sidebar is the narrow rail of icons, from laptop width up (components/AppShell).
// It is a choice of this viewer's, kept in this browser: the only thing the app keeps in local
// storage, under one key, with one of two words as its value. Nothing else is ever written there
// (test/source-rules.test.ts holds the app to that).
//
// The state lives on the document's root element, as `data-sidebar="rail"`, and the page's look
// follows it in CSS (the `rail:` variant of app/globals.css). The root layout runs `SIDEBAR_SCRIPT`
// in the head, before the page is drawn, so a page loaded with the rail chosen is drawn as a rail
// at once: no frame of the wide sidebar first. React reads the same attribute (`sidebarStore`), for
// the toggle's state and its words.

/** The key in local storage, and the two words it can hold. */
export const SIDEBAR_KEY = "tender.sidebar";
const RAIL = "rail";
const FULL = "full";

/**
 * Run in the document's head, before the body is drawn: the rail, if this browser chose it. A
 * browser that keeps no storage, or refuses it to the page, gets the wide sidebar. It is a constant
 * of ours and holds nothing from a request.
 */
export const SIDEBAR_SCRIPT = `try{if(window.localStorage.getItem(${JSON.stringify(SIDEBAR_KEY)})===${JSON.stringify(RAIL)})document.documentElement.setAttribute("data-sidebar",${JSON.stringify(RAIL)})}catch(e){}`;

const listeners = new Set<() => void>();

/** Draws the sidebar as the rail or not, by the root element's attribute. */
function apply(rail: boolean): void {
  const root = document.documentElement;
  if (rail) root.setAttribute("data-sidebar", RAIL);
  else root.removeAttribute("data-sidebar");
  for (const listener of [...listeners]) listener();
}

/** What this browser has kept, or null if nothing, or if it keeps nothing for the page. */
function stored(): boolean | null {
  try {
    const value = window.localStorage.getItem(SIDEBAR_KEY);
    return value === RAIL ? true : value === FULL ? false : null;
  } catch {
    return null;
  }
}

/** The sidebar's state for `useSyncExternalStore`: true while it is the rail. */
export const sidebarStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot(): boolean {
    return document.documentElement.getAttribute("data-sidebar") === RAIL;
  },
  /** The page as the server draws it: the wide sidebar. The head's script has the last word. */
  getServerSnapshot(): boolean {
    return false;
  },
};

/** Chooses the rail or the wide sidebar, and keeps the choice if the browser lets the page. */
export function setRail(rail: boolean): void {
  apply(rail);
  try {
    window.localStorage.setItem(SIDEBAR_KEY, rail ? RAIL : FULL);
  } catch {
    // No storage: the choice holds until the page is loaded again.
  }
}

/**
 * The kept choice, put back on the page. The head's script does it when a page is loaded; this
 * does it when the shell comes back without a load (from the landing, by a link), as the script
 * runs only once. Without a kept choice the page stays as it is.
 */
export function restoreSidebar(): void {
  const rail = stored();
  if (rail !== null && rail !== sidebarStore.getSnapshot()) apply(rail);
}
