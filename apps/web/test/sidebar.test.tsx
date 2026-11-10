import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import RootLayout from "../app/layout";
import { AppShell } from "../components/AppShell";
import { restoreSidebar, SIDEBAR_KEY, SIDEBAR_SCRIPT, setRail } from "../lib/sidebar";
import { agent, summary } from "./tasks";

// The sidebar's rail (components/AppShell.tsx, lib/sidebar.ts): the toggle and its shortcut, the
// choice kept in this browser and put back before the page is drawn, and the rail's names and
// tooltips. The rail's look is CSS on the root element's attribute; jsdom has no layout, so these
// tests hold the attribute, the names and the states, and e2e/sidebar.spec.ts the look.

// No jest-dom here (X-20): plain assertions on what the Testing Library finds.

const pathname = vi.hoisted(() => ({ current: "/tasks" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

// The wallet as the top bar reads it, with nothing connected; the real one looks for near-connect.
vi.mock("../lib/wallet", () => {
  const state = { ready: true, accountId: null, canSignMessage: true };
  return {
    walletStore: {
      subscribe: () => () => {},
      getSnapshot: () => state,
      getServerSnapshot: () => state,
      // The shell starts the store on mount; here there is nothing to start.
      start: async () => {},
    },
  };
});

const root = () => document.documentElement;
const isRail = () => root().getAttribute("data-sidebar") === "rail";

beforeEach(() => {
  // The top bar's Live pill reads the API: here it is down, and the pill says Offline.
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("Failed to fetch");
  });
  window.localStorage.clear();
  root().removeAttribute("data-sidebar");
  pathname.current = "/tasks";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  root().removeAttribute("data-sidebar");
});

function shell(children: ReactNode = <p>The page</p>) {
  return render(<AppShell>{children}</AppShell>);
}

const toggle = () => screen.getByRole("button", { name: "Sidebar" });

/** ⌘B (or Ctrl+B) as the browser sends it, to whatever has the focus. */
function pressShortcut(modifier: "metaKey" | "ctrlKey" = "metaKey", target?: Element) {
  return fireEvent.keyDown(target ?? document.activeElement ?? document.body, {
    key: "b",
    code: "KeyB",
    [modifier]: true,
  });
}

test("sidebar_toggle_makes_the_rail_and_back_and_says_which_it_does", async () => {
  shell();
  const button = toggle();
  const sidebar = document.getElementById(button.getAttribute("aria-controls") ?? "");
  expect(sidebar?.tagName).toBe("ASIDE");
  // It is in the sidebar's head, beside the wordmark.
  expect(sidebar?.contains(button)).toBe(true);
  // Its name is what it controls, whatever the state; the state is `aria-expanded`'s to say.
  expect(button.getAttribute("aria-label")).toBe("Sidebar");
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(button.getAttribute("aria-keyshortcuts")).toBe("Meta+B Control+B");
  expect(isRail()).toBe(false);

  await userEvent.click(button);
  expect(isRail()).toBe(true);
  expect(button.getAttribute("aria-label")).toBe("Sidebar");
  expect(button.getAttribute("aria-expanded")).toBe("false");
  // The focus stays on the button that was pressed: it does not move with the rail.
  expect(document.activeElement).toBe(button);

  await userEvent.click(button);
  expect(isRail()).toBe(false);
  expect(button.getAttribute("aria-label")).toBe("Sidebar");
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(button);
});

test("sidebar_choice_is_kept_and_put_back_the_next_time", async () => {
  const first = shell();
  await userEvent.click(toggle());
  expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("rail");
  first.unmount();

  // The page is loaded again: the head's script puts the rail back before anything is drawn.
  root().removeAttribute("data-sidebar");
  new Function(SIDEBAR_SCRIPT)();
  expect(isRail()).toBe(true);
  shell();
  expect(toggle().getAttribute("aria-expanded")).toBe("false");

  // The wide sidebar is a choice too, and it is kept as one.
  await userEvent.click(toggle());
  expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("full");
  root().removeAttribute("data-sidebar");
  new Function(SIDEBAR_SCRIPT)();
  expect(isRail()).toBe(false);
});

test("sidebar_choice_comes_back_when_the_shell_is_reached_without_a_load", () => {
  // From the landing by a link: the head's script ran on the landing's load, before the choice.
  window.localStorage.setItem(SIDEBAR_KEY, "rail");
  shell();
  expect(isRail()).toBe(true);
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
});

test("sidebar_works_without_storage_and_keeps_the_choice_for_the_page", async () => {
  // A browser that refuses the page its storage: every read and write throws.
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  // The head's script draws the wide sidebar, and throws nothing.
  expect(() => new Function(SIDEBAR_SCRIPT)()).not.toThrow();
  expect(isRail()).toBe(false);

  shell();
  await userEvent.click(toggle());
  expect(isRail()).toBe(true);
  // Without a kept choice, coming back leaves the page as it is.
  restoreSidebar();
  expect(isRail()).toBe(true);
  await userEvent.click(toggle());
  expect(isRail()).toBe(false);
});

test("sidebar_script_is_in_the_head_of_every_page_and_is_ours", () => {
  // The root layout's tree, as the server renders it: the script is the head's first child, so it
  // runs before the body is parsed.
  const html = RootLayout({ children: <p>page</p> }) as ReactElement<{
    children: ReactNode;
    suppressHydrationWarning?: boolean;
  }>;
  expect(html.type).toBe("html");
  // The script sets an attribute on <html> that the server does not render.
  expect(html.props.suppressHydrationWarning).toBe(true);
  const [head] = [html.props.children].flat() as ReactElement<{ children: ReactNode }>[];
  expect(head?.type).toBe("head");
  const script = [head?.props.children].flat()[0];
  expect(isValidElement(script) && script.type === "script").toBe(true);
  expect((script as ReactElement<{ children: string }>).props.children).toBe(SIDEBAR_SCRIPT);

  // A constant: one key, one word, and nothing else from storage or the request.
  expect(SIDEBAR_SCRIPT).toBe(
    'try{if(window.localStorage.getItem("tender.sidebar")==="rail")document.documentElement.setAttribute("data-sidebar","rail")}catch(e){}',
  );
});

test("sidebar_shortcut_toggles_with_command_or_control_b", () => {
  shell();
  const event = pressShortcut("metaKey", document.body);
  expect(event).toBe(false); // the browser's own ⌘B (bookmarks, bold) is not done as well
  expect(isRail()).toBe(true);
  expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("rail");

  pressShortcut("ctrlKey", document.body);
  expect(isRail()).toBe(false);

  // With another key held as well it is some other shortcut, and not the sidebar's.
  fireEvent.keyDown(document.body, { key: "b", metaKey: true, shiftKey: true });
  fireEvent.keyDown(document.body, { key: "b", ctrlKey: true, altKey: true });
  fireEvent.keyDown(document.body, { key: "b" });
  expect(isRail()).toBe(false);
  // Caps Lock on.
  fireEvent.keyDown(document.body, { key: "B", metaKey: true });
  expect(isRail()).toBe(true);
});

test("sidebar_shortcut_is_left_to_a_text_field_that_has_the_focus", () => {
  shell(
    <form>
      <input aria-label="Title" />
      <input aria-label="Email" type="email" />
      <textarea aria-label="Brief" />
      <input aria-label="Sealed" type="checkbox" />
      <button type="button">Save</button>
    </form>,
  );
  for (const name of ["Title", "Email", "Brief"]) {
    // A text field, an email field and a text area all have the role textbox.
    const field = screen.getByRole("textbox", { name });
    field.focus();
    const event = pressShortcut("metaKey", field);
    // ⌘B is the field's (bold, in some), so the page leaves it alone.
    expect(event, name).toBe(true);
    expect(isRail(), name).toBe(false);
    pressShortcut("ctrlKey", field);
    expect(isRail(), name).toBe(false);
  }
  // A checkbox or a button takes no typing: the shortcut is the page's there.
  const box = screen.getByRole("checkbox", { name: "Sealed" });
  box.focus();
  pressShortcut("metaKey", box);
  expect(isRail()).toBe(true);
  const save = screen.getByRole("button", { name: "Save" });
  save.focus();
  pressShortcut("ctrlKey", save);
  expect(isRail()).toBe(false);
});

test("sidebar_shortcut_does_nothing_below_laptop_width", () => {
  // A phone or a narrow window: the sidebar is a menu there, with no rail to choose.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  shell();
  const event = pressShortcut("metaKey", document.body);
  expect(event).toBe(true);
  expect(isRail()).toBe(false);
  expect(window.localStorage.getItem(SIDEBAR_KEY)).toBeNull();
});

test("sidebar_rail_keeps_every_link_by_its_name_and_marks_the_page", async () => {
  pathname.current = "/providers/acme.near";
  shell();
  const nav = screen.getByRole("navigation", { name: "Main" });
  const names = () =>
    within(nav)
      .getAllByRole("link")
      .map((link) => link.getAttribute("aria-label"));
  const wide = names();
  expect(wide).toEqual([
    "Marketplace",
    "Post a task",
    "My tasks",
    "Browse agents",
    "Services",
    "Add an agent",
    "My agents",
    "Activity",
    "Earnings",
    "Wallet",
    "Settings",
    "How it works",
  ]);

  await userEvent.click(toggle());
  expect(isRail()).toBe(true);
  // Every link is still there, by the same name, and the page you are on is still marked.
  expect(names()).toEqual(wide);
  for (const label of wide) {
    expect(within(nav).getByRole("link", { name: label ?? "" })).toBeTruthy();
  }
  // A provider's page is under Browse agents, whose tab Providers is.
  expect(within(nav).getByRole("link", { current: "page" }).getAttribute("aria-label")).toBe(
    "Browse agents",
  );
  // Each group keeps its title for a screen reader, which reads the group by it.
  expect(nav.textContent).toContain("Agents");
  expect(nav.textContent).toContain("Account");
});

test("sidebar_groups_hold_the_pages_in_their_final_order_with_how_it_works_under_docs", async () => {
  shell();
  const nav = screen.getByRole("navigation", { name: "Main" });
  // Each group's links, by the group's title (the top group has none).
  const groups = [...nav.querySelectorAll("ul")].map((list) => {
    const title = list.parentElement?.querySelector("p")?.textContent ?? null;
    return [
      title,
      within(list)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ];
  });
  expect(groups).toEqual([
    [null, ["/tasks"]],
    ["Tasks", ["/post", "/my-tasks"]],
    ["Agents", ["/agents", "/services", "/my-agents/new", "/my-agents"]],
    ["Account", ["/activity", "/earnings", "/wallet", "/settings"]],
    ["Docs", ["/how-it-works"]],
  ]);
  // How it works is the last link of all, under Docs, and the only one to it.
  const how = within(nav).getAllByRole("link", { name: "How it works" });
  expect(how.map((link) => link.getAttribute("href"))).toEqual(["/how-it-works"]);
  // Metrics is behind the Live block, under the links.
  const live = screen.getByTestId("sidebar-live");
  expect(within(live).getByRole("link", { name: "All metrics" }).getAttribute("href")).toBe(
    "/metrics",
  );

  // Each new page is marked as the one you are on, from the sidebar; Telegram is under Settings.
  for (const [path, name] of [
    ["/activity", "Activity"],
    ["/my-tasks", "My tasks"],
    ["/settings", "Settings"],
    ["/telegram", "Settings"],
    ["/how-it-works", "How it works"],
  ] as const) {
    cleanup();
    pathname.current = path;
    shell();
    const marked = within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", {
      current: "page",
    });
    expect(marked.getAttribute("aria-label"), path).toBe(name);
  }
});

test("sidebar_rail_names_every_new_page_in_a_tooltip", async () => {
  shell();
  await userEvent.click(toggle());
  for (const name of ["Activity", "My tasks", "Settings", "How it works", "All metrics"]) {
    const link = screen.getByRole("link", { name });
    await userEvent.hover(link);
    expect(screen.getByTestId("sidebar-tip").textContent, name).toBe(name);
    await userEvent.unhover(link);
    await userEvent.keyboard("{Escape}");
  }
});

test("sidebar_rail_names_each_icon_in_a_tooltip_and_escape_takes_it_away", async () => {
  shell();
  const nav = screen.getByRole("navigation", { name: "Main" });
  const services = within(nav).getByRole("link", { name: "Services" });

  // On the wide sidebar the words are there: no tooltip.
  await userEvent.hover(services);
  expect(screen.queryByTestId("sidebar-tip")).toBeNull();
  await userEvent.unhover(services);

  await userEvent.click(toggle());
  await userEvent.hover(services);
  const tip = screen.getByTestId("sidebar-tip");
  expect(tip.textContent).toBe("Services");
  // It repeats the link's name, which a screen reader already has.
  expect(tip.getAttribute("aria-hidden")).toBe("true");

  // Escape takes it away, wherever the pointer is.
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByTestId("sidebar-tip")).toBeNull();

  // The keyboard's focus shows it too.
  act(() => {
    within(nav).getByRole("link", { name: "Earnings" }).focus();
  });
  await userEvent.tab();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Wallet");
  expect(screen.getByTestId("sidebar-tip").textContent).toBe("Wallet");
  // Back to the wide sidebar: the link's tooltip goes, as the words are back.
  act(() => setRail(false));
  expect(screen.queryByTestId("sidebar-tip")).toBeNull();
});

test("sidebar_toggle_tooltip_says_what_a_press_does_and_the_shortcut", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  shell();
  await userEvent.hover(toggle());
  expect(screen.getByTestId("sidebar-tip").textContent).toBe("Hide sidebar⌘B");
  await userEvent.click(toggle());
  // The words follow the sidebar while the pointer stays.
  expect(screen.getByTestId("sidebar-tip").textContent).toBe("Show sidebar⌘B");

  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  await userEvent.unhover(toggle());
  await userEvent.hover(toggle());
  expect(screen.getByTestId("sidebar-tip").textContent).toBe("Show sidebarCtrl+B");
});

test("sidebar_wordmark_moves_to_the_top_bar_and_a_focus_on_it_is_not_lost", async () => {
  shell();
  const sideMark = screen.getByTestId("side-wordmark");
  const barMark = screen.getByTestId("bar-wordmark");
  // Both lead home; CSS shows one of them at a time (the side one wide, the bar's on the rail).
  expect(within(sideMark).getByRole("link", { name: "Tender" }).getAttribute("href")).toBe("/");
  expect(within(barMark).getByRole("link", { name: "Tender" }).getAttribute("href")).toBe("/");
  expect(barMark.className).toContain("lg:rail:block");
  expect(sideMark.className).toContain("lg:rail:invisible");

  // The keyboard is on the sidebar's wordmark when ⌘B puts it away: the focus goes to the toggle,
  // and not to a link that is no longer seen.
  const link = within(sideMark).getByRole("link", { name: "Tender" });
  link.focus();
  pressShortcut("metaKey", link);
  expect(isRail()).toBe(true);
  expect(document.activeElement).toBe(toggle());

  // And back: the top bar's wordmark is put away in turn.
  const barLink = within(barMark).getByRole("link", { name: "Tender" });
  barLink.focus();
  pressShortcut("ctrlKey", barLink);
  expect(isRail()).toBe(false);
  expect(document.activeElement).toBe(toggle());
});

test("sidebar_live_block_shows_the_top_bar_s_figures_from_the_same_reads", async () => {
  // The three reads of the top bar's status, answered: the Live block, pinned under the links,
  // shows their figures and asks the API for nothing more.
  const urls: string[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    urls.push(path);
    if (path === "/v1/tasks?phase=open&limit=50") {
      return json({
        tasks: [summary({ id: "7", reward: "1500000" }), summary({ id: "8", reward: "500000" })],
        next_cursor: null,
      });
    }
    if (path === "/v1/agents?limit=50") return json({ agents: [agent()], next_cursor: null });
    throw new TypeError("Failed to fetch");
  });
  shell();
  const sidebar = document.querySelector("aside");
  const live = screen.getByTestId("sidebar-live");
  expect(sidebar?.contains(live)).toBe(true);
  // It is not among the links, which scroll on their own above it.
  expect(screen.getByRole("navigation", { name: "Main" }).contains(live)).toBe(false);

  await waitFor(() => expect(within(live).getAllByTestId("sidebar-figure")).toHaveLength(3));
  expect(
    within(live)
      .getAllByTestId("sidebar-figure")
      .map((row) => row.textContent),
  ).toEqual(["Open tasks2", "Agents1", "Locked2.00 tUSDC"]);
  // The top bar's status is there too, and the two made the three reads once between them.
  const pill = await within(screen.getByRole("banner")).findByRole("button", {
    name: /^Testnet, /,
  });
  expect(sidebar?.contains(pill)).toBe(false);
  expect(urls.sort()).toEqual([
    "/v1/agents?limit=50",
    "/v1/health",
    "/v1/tasks?phase=open&limit=50",
  ]);
  // On the rail its figures go: the dot and the link to Metrics stay.
  expect(live.querySelector("dl")?.className).toContain("lg:rail:hidden");
  expect(within(live).getByRole("link", { name: "All metrics" }).getAttribute("href")).toBe(
    "/metrics",
  );
});
