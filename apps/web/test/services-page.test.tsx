import type { Service } from "@tender/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ServiceDirectory } from "../components/ServiceDirectory";
import { ServiceView } from "../components/ServiceView";
import { createWalletStore, type WalletStore } from "../lib/wallet";
import { agent, TOKEN } from "./tasks";
import { fakeProvider } from "./walletDoubles";

// The Services page and a service's page over a fake API. The directory's search and tag are in
// the address, so the tests hand it the search parameters a page would have, and see the address it
// writes back. A service's page uses the real wallet hook over a double that is not connected.

const search = vi.hoisted(() => ({ current: new URLSearchParams(), replaced: [] as string[] }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => search.current,
  usePathname: () => "/services",
  useRouter: () => ({ replace: (href: string) => search.replaced.push(href) }),
}));

const holder = vi.hoisted(() => ({ store: undefined as unknown as WalletStore }));
vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return { ...actual, useWallet: () => actual.useWalletStore(holder.store) };
});

const WRITER = "writer.acme.testnet";

function service(over: Partial<Service> = {}): Service {
  return {
    id: "3",
    provider: "acme.testnet",
    agent: WRITER,
    title: "Summarise a public filing",
    description: "Reads a filing <b>and</b> returns five lines.",
    tags: ["research", "filings"],
    category: "research",
    output_format: "text",
    token: TOKEN,
    price: "2500000",
    commit_secs: 3_600,
    reveal_secs: 1_800,
    pick_secs: 3_600,
    verification: { kind: "hirer" },
    status: "active",
    available: true,
    is_team: false,
    created_at: "2026-11-04T09:00:00.000Z",
    updated_at: "2026-11-04T09:00:00.000Z",
    agent_record: agent({
      account: WRITER,
      asp: "acme.testnet",
      entries: 14,
      reveals: 13,
      wins: 9,
      earned: { [TOKEN]: "21375000", "other.testnet": "7" },
      is_team: false,
    }),
    ...over,
  };
}

const JUDGED = service({
  id: "4",
  agent: "scout.tender-team.testnet",
  provider: "tender-team.testnet",
  title: "Extract every date",
  description: "One regex for ISO dates.",
  tags: ["extraction"],
  output_format: "regex_json",
  price: "900000",
  is_team: true,
  verification: {
    kind: "judge",
    criteria: {
      version: 1,
      kind: "regex_cases",
      min_score: 100,
      split: "winner_take_all",
      has_heldout: false,
      examples: { match: ["2026-11-04"], no_match: ["4 Nov"] },
    },
    criteria_hash: "ab".repeat(32),
  },
  agent_record: agent({ account: "scout.tender-team.testnet", wins: 31, earned: {} }),
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fakeApi(handler: (url: URL) => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.origin === "http://rpc.test") return json({ jsonrpc: "2.0", id: "x", error: {} });
    calls.push(`${url.pathname}${url.search}`);
    return handler(url);
  });
  return { calls };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  holder.store = createWalletStore(async () =>
    fakeProvider({ wallet: undefined as never, accountId: "nobody.testnet" }, { restored: false }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  search.current = new URLSearchParams();
  search.replaced = [];
});

// ---- The directory ------------------------------------------------------------------------------

test("the_directory_shows_each_service_with_its_price_check_and_the_agents_record", async () => {
  const { calls } = fakeApi(() => json({ services: [JUDGED, service()], next_cursor: null }));
  render(<ServiceDirectory />);

  const cards = await screen.findAllByTestId("service-card");
  expect(cards).toHaveLength(2);
  expect(calls).toEqual(["/v1/services?limit=50"]);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "Services. Hire an agent for a fixed price.",
  );
  const [judged, hired] = cards as [HTMLElement, HTMLElement];
  expect(
    within(hired).getByRole("link", { name: "Summarise a public filing" }).getAttribute("href"),
  ).toBe("/services/3");
  expect(within(hired).getByTestId("service-price").textContent).toBe("Price: 2.50 tUSDC");
  expect(within(hired).getByTestId("service-checked").textContent).toBe("You accept the work");
  expect(within(judged).getByTestId("service-checked").textContent).toBe("Tender Judge checks");
  expect(within(hired).getByTestId("service-wins").textContent).toBe("9");
  // Earned a token at a time, never added up.
  expect(
    within(within(hired).getByTestId("service-earned"))
      .getAllByTestId("amount")
      .map((amount) => amount.textContent),
  ).toEqual(["21.375 tUSDC", "7 other.testnet"]);
  expect(within(judged).getByTestId("service-earned").textContent).toBe("Nothing yet");
  // The team's label goes with an agent the team runs, and with no other.
  expect(within(judged).getByTestId("team-badge")).toBeTruthy();
  expect(within(hired).queryByTestId("team-badge")).toBeNull();
  expect(within(hired).getByText("Provider")).toBeTruthy();
  // Hire is a link of its own, to the form on the service's page.
  expect(
    within(hired)
      .getByRole("link", { name: "Hire: Summarise a public filing" })
      .getAttribute("href"),
  ).toBe("/services/3#hire");
  // The provider's words are text: markup in them is not read as markup.
  expect(hired.querySelector("b")).toBeNull();
  expect(hired.textContent).toContain("<b>and</b>");
});

test("the_tag_and_the_search_narrow_the_list_and_live_in_the_address", async () => {
  fakeApi(() => json({ services: [JUDGED, service()], next_cursor: null }));
  search.current = new URLSearchParams({ tag: "extraction" });
  render(<ServiceDirectory />);

  expect((await screen.findAllByTestId("service-card")).map((card) => card.textContent)).toEqual([
    expect.stringContaining("Extract every date"),
  ]);
  const filter = within(screen.getByRole("navigation", { name: "Filter by tag" }));
  expect(filter.getByRole("link", { name: "extraction" }).getAttribute("aria-current")).toBe(
    "true",
  );
  expect(filter.getByRole("link", { name: "All" }).getAttribute("href")).toBe("/services");

  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Search services"), "poetry");
  expect(screen.getByTestId("no-matching-services").textContent).toBe(
    "No service with the tag extraction matches.",
  );
  expect(search.replaced.at(-1)).toBe("/services?q=poetry&tag=extraction");
});

test("a_search_finds_words_of_the_title_and_the_description", async () => {
  fakeApi(() => json({ services: [JUDGED, service()], next_cursor: null }));
  search.current = new URLSearchParams({ q: "FIVE LINES" });
  render(<ServiceDirectory />);
  const cards = await screen.findAllByTestId("service-card");
  expect(cards).toHaveLength(1);
  expect(cards[0]?.textContent).toContain("Summarise a public filing");
});

test("the_directory_reads_every_page_before_it_shows_any", async () => {
  const { calls } = fakeApi((url) =>
    url.searchParams.get("cursor") === null
      ? json({ services: [JUDGED], next_cursor: "4" })
      : json({ services: [service()], next_cursor: null }),
  );
  render(<ServiceDirectory />);
  expect(await screen.findAllByTestId("service-card")).toHaveLength(2);
  expect(calls).toEqual(["/v1/services?limit=50", "/v1/services?limit=50&cursor=4"]);
});

test("the_directory_has_an_empty_state_and_an_error_it_can_retry", async () => {
  fakeApi(() => json({ services: [], next_cursor: null }));
  const { unmount } = render(<ServiceDirectory />);
  const empty = await screen.findByTestId("no-services");
  expect(empty.textContent).toContain("No services yet");
  expect(within(empty).getByRole("link", { name: "My agents" }).getAttribute("href")).toBe(
    "/my-agents",
  );
  unmount();

  let fail = true;
  fakeApi(() =>
    fail
      ? json({ error: "internal", message: "db down at 10.0.3.7" }, 500)
      : json({ services: [service()], next_cursor: null }),
  );
  render(<ServiceDirectory />);
  const alert = await screen.findByRole("alert");
  // A server fault is given only its status, never its words.
  expect(alert.textContent).not.toContain("10.0.3.7");
  fail = false;
  await userEvent.setup().click(within(alert).getByRole("button", { name: "Retry" }));
  expect(await screen.findAllByTestId("service-card")).toHaveLength(1);
});

// ---- A service's page ---------------------------------------------------------------------------

test("a_service_page_says_what_it_does_how_it_is_checked_and_what_the_agent_has_done", async () => {
  const { calls } = fakeApi(() => json({ service: service() }));
  render(<ServiceView id="3" />);

  expect(
    await screen.findByRole("heading", { level: 1, name: "Summarise a public filing" }),
  ).toBeTruthy();
  expect(calls[0]).toBe("/v1/services/3");
  expect(screen.getByTestId("service-description").textContent).toBe(
    "Reads a filing <b>and</b> returns five lines.",
  );
  expect(screen.getByTestId("service-checked-sentence").textContent).toMatch(
    /^You check the work yourself/,
  );
  expect(screen.getByTestId("record-wins").textContent).toBe("9");
  expect(screen.getByTestId("record-entries").textContent).toBe("14");
  expect(screen.getByTestId("hire-price").textContent).toBe("2.50 tUSDC");
  // The money, as it is: escrowed, paid less the fee, all of it back if nothing is delivered.
  const note = screen.getByTestId("money-note").textContent ?? "";
  expect(note).toContain("held by the Tender contract");
  expect(note).toContain("less the platform fee");
  expect(note).toContain("all of it comes back to you");
  // Not connected: the form asks for a wallet, and has nothing to send.
  const hire = within(document.getElementById("hire") as HTMLElement);
  expect(await hire.findByRole("button", { name: "Connect wallet" })).toBeTruthy();
  expect(hire.queryByLabelText("Your request")).toBeNull();
});

test("a_judge_checked_service_names_its_criteria_and_says_when_the_judge_takes_it_from_the_team_only", async () => {
  fakeApi(() => json({ service: JUDGED }));
  render(<ServiceView id="4" />);
  expect(await screen.findByTestId("service-checked-sentence")).toBeTruthy();
  expect(screen.getByTestId("service-checked-sentence").textContent).toContain(
    "regex cases, pass mark 100",
  );
  expect(document.body.textContent).toContain(`sha256 ${"ab".repeat(32)}`);
  expect(screen.queryByTestId("team-only-note")).toBeNull();

  const rubric = service({
    verification: {
      kind: "judge",
      criteria: {
        version: 1,
        kind: "rubric",
        min_score: 60,
        split: "winner_take_all",
        has_heldout: false,
        rubric: [{ criterion: "Covers every section", weight: 1 }],
      },
      criteria_hash: "cd".repeat(32),
    },
  });
  fakeApi(() => json({ service: rubric }));
  render(<ServiceView id="5" />);
  expect((await screen.findByTestId("team-only-note")).textContent).toContain(
    "the price comes back to you",
  );
});

test("a_paused_service_and_one_whose_agent_left_cannot_be_hired", async () => {
  fakeApi(() => json({ service: service({ status: "paused", available: false }) }));
  const { unmount } = render(<ServiceView id="3" />);
  expect((await screen.findByTestId("hire-blocked")).textContent).toBe(
    "The provider has paused this service. It can't be hired now.",
  );
  expect(screen.getByTestId("service-status").textContent).toBe("Paused");
  unmount();

  fakeApi(() => json({ service: service({ available: false }) }));
  render(<ServiceView id="3" />);
  expect((await screen.findByTestId("hire-blocked")).textContent).toContain(
    "isn't an active agent with a bond",
  );
  expect(screen.getByTestId("service-status").textContent).toBe("Not taking work");
});

test("an_unknown_service_is_not_found_and_an_id_that_is_none_is_not_asked_for", async () => {
  const { calls } = fakeApi(() => json({ error: "not_found", message: "no such service" }, 404));
  const { unmount } = render(<ServiceView id="77" />);
  expect((await screen.findByTestId("service-missing")).textContent).toBe(
    "There is no service with this number.",
  );
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Service #77");
  unmount();
  render(<ServiceView id="../agents" />);
  await screen.findByTestId("service-missing");
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Service");
  await waitFor(() => expect(calls).toEqual(["/v1/services/77"]));
});
