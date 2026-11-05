import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import Landing from "../app/page";
import { MCP_DOCS_URL, REPO_URL, SKILL_URL } from "../lib/links";

// The landing (app/page.tsx): what it says Tender is, where its links go, and what it never says.
// Its parts are in landing-parts.test.tsx.

// No jest-dom here (X-20): plain assertions on what the Testing Library finds.

// The tab's wallet as the landing's top bar reads it: a store nothing here starts, in the state a
// test sets. The real one (lib/wallet.ts) would look for near-connect.
const wallet = vi.hoisted(() => ({
  state: { ready: false, accountId: null as string | null, canSignMessage: true },
  listeners: new Set<() => void>(),
  starts: 0,
}));
vi.mock("../lib/wallet", () => ({
  walletStore: {
    subscribe: (listener: () => void) => {
      wallet.listeners.add(listener);
      return () => wallet.listeners.delete(listener);
    },
    getSnapshot: () => wallet.state,
    // The server knows no wallet.
    getServerSnapshot: () => ({ ready: false, accountId: null, canSignMessage: false }),
    start: async () => {
      wallet.starts++;
    },
  },
}));

/** The tab's wallet changes to `state`, as a page of the app that connects it would make it. */
function walletIs(state: { ready: boolean; accountId: string | null }): void {
  act(() => {
    wallet.state = { ...wallet.state, ...state };
    for (const listener of wallet.listeners) listener();
  });
}

/** The API down: every request fails before it is answered. */
const apiDown = () =>
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("Failed to fetch");
  });

beforeEach(() => {
  // jsdom has no canvas: the art draws nothing.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wallet.state = { ready: false, accountId: null, canSignMessage: true };
  wallet.starts = 0;
});

test("landing_says_what_tender_is_and_its_links_lead_to_real_pages", async () => {
  apiDown();
  render(<Landing />);

  const title = screen.getByRole("heading", { level: 1 });
  expect(title.textContent).toBe("Post a task.Agents compete.The contract pays.");

  const hrefs = (name: string) =>
    screen.getAllByRole("link", { name }).map((link) => link.getAttribute("href"));
  expect(new Set(hrefs("Post a task"))).toEqual(new Set(["/post"]));
  expect(hrefs("Browse tasks")).toEqual(["/tasks"]);
  expect(hrefs("Find a task")).toEqual(["/tasks"]);
  expect(hrefs("See the records")).toEqual(["/agents"]);
  // The top bar's way in is the market, whatever the wallet; it offers no Connect wallet.
  expect(hrefs("Launch market")).toEqual(["/tasks"]);
  expect(screen.queryByRole("link", { name: "Connect wallet" })).toBeNull();
  expect(screen.getByRole("link", { name: /Explore tasks/ }).getAttribute("href")).toBe("/tasks");
  expect(screen.getByRole("link", { name: /Explore agents/ }).getAttribute("href")).toBe("/agents");

  expect(hrefs("See providers")).toEqual(["/providers"]);
  expect(hrefs("Add an agent")).toEqual(["/my-agents/new"]);
  // How it works from the hero, the top bar, the steps and the footer.
  expect(new Set(hrefs("How it works"))).toEqual(new Set(["/how-it-works"]));
  const hero = screen.getByRole("region", { name: /Post a task\./ });
  expect(within(hero).getByRole("link", { name: "How it works" }).getAttribute("href")).toBe(
    "/how-it-works",
  );
  // The agents' card and the footer link the guide and the MCP docs, and the footer the source.
  const roles = screen.getByRole("heading", { name: "Four ways in >" }).closest("section");
  const agents = within(roles as HTMLElement)
    .getByRole("heading", { level: 3, name: "Agents" })
    .closest("li");
  expect(
    within(agents as HTMLElement)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href")),
  ).toEqual([SKILL_URL, MCP_DOCS_URL, "/tasks"]);
  const footer = within(screen.getByRole("contentinfo"));
  expect(footer.getByRole("link", { name: "Source code" }).getAttribute("href")).toBe(REPO_URL);
  expect(footer.getByRole("link", { name: "Agent guide" }).getAttribute("href")).toBe(SKILL_URL);

  // Every link stays in the app, on a page that exists, but those to the source and its docs.
  const pages = new Set([
    "/",
    "/tasks",
    "/agents",
    "/post",
    "/wallet",
    "/telegram",
    "/providers",
    "/my-agents/new",
    "/how-it-works",
    "/services",
    REPO_URL,
    SKILL_URL,
    MCP_DOCS_URL,
  ]);
  for (const link of screen.getAllByRole("link")) {
    expect(pages.has(link.getAttribute("href") ?? ""), link.textContent ?? "").toBe(true);
  }

  // The honesty line about what the team runs.
  expect(screen.getByRole("contentinfo").textContent).toContain("Run by Tender team");
  await waitFor(() => expect(screen.getAllByTestId("ticker-fact").length).toBeGreaterThan(0));
});

test("landing_top_bar_links_the_app_s_main_areas_and_launches_the_market", () => {
  apiDown();
  render(<Landing />);

  const bar = within(screen.getByRole("navigation", { name: "Main" }));
  expect(
    bar.getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")]),
  ).toEqual([
    ["Tasks", "/tasks"],
    ["Agents", "/agents"],
    ["Services", "/services"],
    ["How it works", "/how-it-works"],
  ]);
  const banner = within(screen.getAllByRole("banner")[0] as HTMLElement);
  const launch = banner.getByRole("link", { name: "Launch market" });
  expect(launch.getAttribute("href")).toBe("/tasks");
  // Its name is whole on a phone too, where the words are cut to "Launch".
  expect(launch.textContent).toBe("Launch\u00a0market");
});

test("landing_top_bar_shows_the_connected_account_and_nothing_until_the_tab_knows", () => {
  apiDown();
  render(<Landing />);
  const banner = within(screen.getAllByRole("banner")[0] as HTMLElement);
  const links = () =>
    banner.getAllByRole("link").map((link) => link.getAttribute("aria-label") ?? link.textContent);

  // The landing looks for the wallet of an earlier visit as soon as it is in the browser.
  expect(wallet.starts).toBe(1);
  // Before the tab knows of a wallet: Launch market alone, and no Connect wallet ever.
  expect(links()).toEqual([
    "Tender",
    "Tasks",
    "Agents",
    "Services",
    "How it works",
    "Launch market",
  ]);
  // It knows: none is connected. Still nothing but Launch market.
  walletIs({ ready: true, accountId: null });
  expect(links()).toEqual([
    "Tender",
    "Tasks",
    "Agents",
    "Services",
    "How it works",
    "Launch market",
  ]);
  expect(banner.queryByRole("link", { name: /Connect/ })).toBeNull();

  // A page of the app connected a wallet in this tab: its account is beside Launch market, as the
  // app's top bar shows it, and leads to the Wallet page.
  walletIs({ ready: true, accountId: "alice.testnet" });
  const account = banner.getByRole("link", { name: "alice.testnet" });
  expect(account.getAttribute("href")).toBe("/wallet");
  expect(account.getAttribute("title")).toBe("alice.testnet");
  expect(account.querySelector(".truncate")?.textContent).toBe("alice.testnet");
  expect(banner.getByRole("link", { name: "Launch market" }).getAttribute("href")).toBe("/tasks");

  // And it goes when the wallet does.
  walletIs({ ready: true, accountId: null });
  expect(banner.queryByRole("link", { name: "alice.testnet" })).toBeNull();
});

test("landing_never_makes_claims_it_cannot_back", () => {
  apiDown();
  const { container } = render(<Landing />);
  const text = (container.textContent ?? "").toLowerCase();
  for (const word of ["trustless", "provably fair", "private"]) {
    expect(text, word).not.toContain(word);
  }
});

test("landing_says_a_pick_pays_the_platform_fee_and_names_no_rate", () => {
  apiDown();
  const { container } = render(<Landing />);

  // A pick with winners pays the fee to the treasury and the rest to the winners; a task with no
  // winner refunds each of its funders (the poster, and anyone who topped it up) all it put in
  // (contract/tender/src/settle.rs, `split_reward`, `refund_funders`).
  const escrow = screen.getByRole("heading", { name: "Escrow in the contract" }).closest("li");
  expect(escrow?.textContent).toContain(
    "It goes to the winners, less the platform fee, or back to its funders in full.",
  );
  expect(escrow?.textContent).not.toContain("back to the poster");

  const text = container.textContent ?? "";
  expect(text).not.toMatch(/only to a winner/i);
  // The contract's owner can change the fee, so the page states no rate.
  expect(text).not.toMatch(/\d\s*(%|percent|bps)/i);
});

test("landing_has_four_ways_in_and_providers_are_one", () => {
  apiDown();
  render(<Landing />);

  const roles = screen.getByRole("heading", { name: "Four ways in >" }).closest("section");
  const cards = [...(roles?.querySelectorAll("ul > li:has(> h3)") ?? [])];
  expect(cards.map((card) => card.querySelector("h3")?.textContent)).toEqual([
    "Posters",
    "Agents",
    "Checkers",
    "Providers (ASPs)",
  ]);
  const providers = cards[3] as HTMLElement;
  expect([...providers.querySelectorAll("ul > li")].map((line) => line.textContent)).toEqual([
    ">Run a fleet of agents under your account.",
    ">Each agent bonds and earns on its own record.",
    ">Posters can hire your agents directly.",
  ]);
  expect(providers.querySelector("a")?.getAttribute("href")).toBe("/providers");
});

test("landing_shows_a_fleet_and_says_what_an_asp_is_the_first_time", () => {
  apiDown();
  const { container } = render(<Landing />);

  const fleet = screen.getByRole("heading", { level: 2, name: "Run a fleet." }).closest("section");
  expect(fleet).toBeTruthy();
  // The first mention of a provider on the page spells it out, and it comes before the roles.
  const text = container.textContent ?? "";
  const first = text.search(/provider|ASP/);
  expect(text.slice(first - "agent service ".length)).toMatch(/^agent service provider \(ASP\)/);
  expect(first).toBeLessThan(text.indexOf("Four ways in"));
  // The sub-account guarantee, in a line.
  expect(fleet?.textContent).toContain(
    "NEAR lets only you.near create its sub-accounts, so the link can’t be faked.",
  );

  // The art moves (a canvas, with no figures in it), and the names beside it are decoration that
  // a sentence says again for a screen reader.
  expect(fleet?.querySelector('[data-testid="art-fleet"]')).toBeTruthy();
  const agents = [...(fleet?.querySelectorAll('[data-testid="fleet-agent"]') ?? [])];
  expect(agents.map((agent) => agent.textContent)).toEqual([
    "writer.you.nearBondRecord",
    "coder.you.nearBondRecord",
    "analyst.you.nearBondRecord",
  ]);
  expect(agents[0]?.closest('[aria-hidden="true"]')).toBeTruthy();
  expect(fleet?.querySelector(".sr-only")?.textContent).toContain(
    "you.near runs writer.you.near, coder.you.near and analyst.you.near",
  );
  // No made-up figures: the fleet shows no amounts, counts or rates.
  expect(fleet?.textContent).not.toMatch(/\d/);
});
