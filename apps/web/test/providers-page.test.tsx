import type { AgentSummary, Service } from "@tender/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AgentCard } from "../components/AgentCard";
import { ProviderDirectory } from "../components/ProviderDirectory";
import { ProviderView } from "../components/ProviderView";
import { canProvide, groupProviders, ownPart } from "../lib/providers";
import { agent, TOKEN } from "./tasks";

// The provider (ASP) pages over a fake API: the directory, which groups every agent the API lists
// by its provider, and a provider's own page, which asks for the agents under it. Every figure is
// one the API gave, added up token by token.

// No jest-dom here (X-20): plain assertions on what the Testing Library finds.

const OTHER_TOKEN = "other.testnet";
const ACME = "acme.testnet";
const TEAM = "tender-team.testnet";

const writer = agent({
  account: `writer.${ACME}`,
  asp: ACME,
  name: "Acme Writer",
  tags: ["writing"],
  entries: 5,
  reveals: 4,
  wins: 2,
  earned: { [TOKEN]: "2500000", [OTHER_TOKEN]: "7" },
  picks_made: 0,
  voids_after_reveals: 0,
  is_team: false,
});
const coder = agent({
  account: `coder.${ACME}`,
  asp: ACME,
  name: "Acme Coder",
  tags: ["coding"],
  entries: 3,
  reveals: 3,
  wins: 1,
  earned: { [TOKEN]: "1000000" },
  picks_made: 0,
  voids_after_reveals: 0,
  is_team: false,
});
const analyst = agent({
  account: `analyst.${ACME}`,
  asp: ACME,
  name: null,
  tags: [],
  entries: 0,
  reveals: 0,
  wins: 0,
  earned: {},
  picks_made: 0,
  voids_after_reveals: 0,
  is_team: false,
});
// The team's judge, under the team's account: the API flags it as the team's.
const judge = agent({ account: `judge.${TEAM}`, asp: TEAM, is_team: true });
// An agent with no provider is in no group.
const carol = agent({ account: "carol.testnet", asp: null, name: "Carol", is_team: false });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const agentsPage = (agents: AgentSummary[], next: string | null = null) =>
  json({ agents, next_cursor: next });
const serverFault = () => json({ error: "internal", message: "db down" }, 500);

/** A `fetch` that hands each request, as a URL, to `handler`, and writes down path and query. */
function fakeApi(handler: (url: URL, call: number) => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    return handler(url, calls.length);
  });
  return { calls };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  // jsdom has no canvas: the art draws nothing.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- Grouping ---------------------------------------------------------------------------------

test("providers_are_grouped_by_the_api_s_asp_and_add_up_token_by_token", () => {
  const providers = groupProviders([analyst, carol, coder, judge, writer]);

  // The largest fleet first; an agent with no provider is in none.
  expect(providers.map((provider) => provider.account)).toEqual([ACME, TEAM]);
  const [acme, team] = providers;
  expect(acme?.agents.map((entry) => entry.account)).toEqual([
    `analyst.${ACME}`,
    `coder.${ACME}`,
    `writer.${ACME}`,
  ]);
  expect(acme?.record.count).toBe(3);
  expect(acme?.record.entries).toBe(8);
  expect(acme?.record.reveals).toBe(7);
  expect(acme?.record.wins).toBe(3);
  // Two tokens, each added up on its own: never one figure for both.
  expect(acme?.record.earned).toEqual([
    [TOKEN, 3_500_000n],
    [OTHER_TOKEN, 7n],
  ]);
  expect(acme?.isTeam).toBe(false);
  // Every agent under the team's account is flagged by the API: the provider is the team's.
  expect(team?.isTeam).toBe(true);

  // A provider with one agent the API does not flag is not the team's.
  const mixed = groupProviders([judge, { ...judge, account: `scout.${TEAM}`, is_team: false }]);
  expect(mixed[0]?.isTeam).toBe(false);
  // Equal fleets go by account, in byte order as the API orders accounts.
  const tie = groupProviders([
    agent({ account: "a.zed.testnet", asp: "zed.testnet" }),
    agent({ account: "a.bee.testnet", asp: "bee.testnet" }),
  ]);
  expect(tie.map((provider) => provider.account)).toEqual(["bee.testnet", "zed.testnet"]);
  expect(groupProviders([carol])).toEqual([]);
  // A provider the registry could never record (an account of one label, such as an implicit one)
  // is no provider, whatever the answer says.
  const implicit = "c0ffee13".repeat(8);
  expect(
    groupProviders([
      agent({ account: "a.near", asp: "near" }),
      agent({ account: "b.testnet", asp: implicit }),
      writer,
    ]).map((provider) => provider.account),
  ).toEqual([ACME]);
});

test("provider_helpers_name_an_agent_by_its_own_part_and_need_two_labels", () => {
  expect(ownPart(`writer.${ACME}`, ACME)).toBe("writer");
  expect(ownPart("deep.writer.acme.testnet", ACME)).toBe("deep.writer");
  // Not under it (the API said so all the same): the whole account.
  expect(ownPart("alice.testnet", "provider.testnet")).toBe("alice.testnet");
  expect(ownPart("xacme.testnet", ACME)).toBe("xacme.testnet");

  expect(canProvide(ACME)).toBe(true);
  expect(canProvide("near")).toBe(false);
  expect(canProvide("c0ffee13".repeat(8))).toBe(false);
  expect(canProvide("../etc")).toBe(false);
});

// ---- The directory ----------------------------------------------------------------------------

test("directory_lists_each_provider_with_its_agents_and_combined_record", async () => {
  const { calls } = fakeApi(() => agentsPage([analyst, carol, coder, judge, writer]));
  render(<ProviderDirectory />);

  const cards = await screen.findAllByTestId("provider-card");
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Providers");
  // The first mention on the page says what the letters stand for.
  const head = screen.getByRole("banner");
  expect(head.textContent).toContain("An agent service provider (ASP) runs agents");
  // One read of the agent list, the API's largest page; nothing is asked of the chain.
  expect(calls).toEqual(["/v1/agents?limit=50"]);

  expect(cards).toHaveLength(2);
  const [acme, team] = cards as [HTMLElement, HTMLElement];
  const link = within(acme).getByRole("link", { name: ACME });
  expect(link.getAttribute("href")).toBe(`/providers/${ACME}`);
  expect(within(acme).getByTestId("provider-agents").textContent).toBe("3");
  expect(within(acme).getByTestId("entries").textContent).toBe("8");
  expect(within(acme).getByTestId("wins").textContent).toBe("3");
  expect(
    within(within(acme).getByTestId("earned"))
      .getAllByTestId("amount")
      .map((amount) => amount.textContent),
  ).toEqual(["3.50 tUSDC", `7 ${OTHER_TOKEN}`]);
  // Its agents, by the part of the account that is their own.
  expect(
    within(acme)
      .getAllByTestId("provider-agent")
      .map((chip) => chip.textContent),
  ).toEqual(["analyst", "coder", "writer"]);
  expect(within(acme).queryByTestId("team-badge")).toBeNull();

  // The team's provider carries the label, as its agents do.
  expect(within(team).getByTestId("team-badge").textContent).toBe("Run by Tender team");
  // An agent's record of nothing is one line, not a row of empty boxes.
  expect(within(team).getByTestId("provider-figures").textContent).toBe(
    "1 agent·0 entries·0 wins·earned nothing yet",
  );
  expect(within(team).getByTestId("earned").textContent).toBe("nothing yet");
  // With figures, the counts are one line too, and what was earned is under it.
  expect(within(acme).getByTestId("provider-figures").textContent).toBe(
    "3 agents·8 entries·3 wins",
  );
});

test("directory_names_four_agents_and_counts_the_rest", async () => {
  const fleet = ["a", "b", "c", "d", "e", "f"].map((name) =>
    agent({ account: `${name}.${ACME}`, asp: ACME, is_team: false }),
  );
  fakeApi(() => agentsPage(fleet));
  render(<ProviderDirectory />);

  const [card] = await screen.findAllByTestId("provider-card");
  expect(
    within(card as HTMLElement)
      .getAllByTestId("provider-agent")
      .map((chip) => chip.textContent),
  ).toEqual(["a", "b", "c", "d"]);
  expect(card?.textContent).toContain("+2 more");
  expect(within(card as HTMLElement).getByTestId("provider-agents").textContent).toBe("6");
});

test("directory_reads_every_page_and_says_when_it_stopped", async () => {
  // Every page has one more after it: the directory stops after ten, and says how many it read.
  const { calls } = fakeApi((_url, call) =>
    agentsPage([{ ...writer, account: `w${call}.${ACME}` }], `w${call}.${ACME}`),
  );
  render(<ProviderDirectory />);

  expect(await screen.findByTestId("providers-truncated")).toBeTruthy();
  expect(calls).toHaveLength(10);
  expect(calls[1]).toBe(`/v1/agents?limit=50&cursor=w1.${ACME}`);
  expect(screen.getByTestId("providers-truncated").textContent).toContain(
    "Grouped from the first 10 agents",
  );
  expect(
    within(screen.getByTestId("provider-card")).getByTestId("provider-agents").textContent,
  ).toBe("10");
});

test("directory_says_when_there_are_no_providers_and_retries_a_failed_read", async () => {
  let fail = true;
  fakeApi(() => (fail ? serverFault() : agentsPage([carol])));
  render(<ProviderDirectory />);

  const error = await screen.findByTestId("error-state");
  expect(error.textContent).toContain("Retry");
  fail = false;
  await userEvent.click(within(error).getByRole("button", { name: "Retry" }));

  // An agent with no provider makes no provider.
  expect((await screen.findByTestId("no-providers")).textContent).toContain("No providers yet.");
  expect(screen.queryByTestId("provider-card")).toBeNull();
});

// ---- A provider's page ------------------------------------------------------------------------

test("provider_page_shows_the_account_its_combined_record_and_its_agents", async () => {
  const { calls } = fakeApi((url) =>
    url.pathname === "/v1/services"
      ? json({ services: [], next_cursor: null })
      : url.searchParams.get("asp") === ACME
        ? agentsPage([analyst, coder, writer])
        : serverFault(),
  );
  render(<ProviderView account={ACME} />);

  const cards = await screen.findAllByTestId("agent-card");
  await screen.findByTestId("no-provider-services");
  expect(calls).toEqual([
    `/v1/agents?asp=${ACME}&limit=50`,
    // Its services for hire, after its agents are known.
    `/v1/services?provider=${ACME}&limit=50`,
  ]);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(ACME);
  // The first mention on the page says what the letters stand for.
  expect(screen.getByRole("banner").textContent).toContain("Agent service provider (ASP)");
  expect(screen.getByRole("link", { name: "All providers" }).getAttribute("href")).toBe(
    "/providers",
  );

  // The combined record: only what the API counted, added up.
  const record = screen.getByLabelText("Its agents together");
  expect(within(record).getByTestId("stat-agents").textContent).toBe("Agents3");
  // The label, the figure, and a few words beside it.
  expect(within(record).getByTestId("stat-entries").textContent).toBe("Entries87 revealed");
  expect(within(record).getByTestId("stat-wins").textContent).toBe("Wins3");
  expect(
    within(within(record).getByTestId("stat-earned"))
      .getAllByTestId("amount")
      .map((amount) => amount.textContent),
  ).toEqual(["3.50 tUSDC", `7 ${OTHER_TOKEN}`]);
  // The API sends no bond fields here: there is no bond figure to make up.
  expect(within(record).queryByTestId("stat-bonds")).toBeNull();

  // The agents, as the directory shows them, a level under the section's title.
  expect(cards).toHaveLength(3);
  expect(screen.getByRole("heading", { level: 2, name: "Its agents" })).toBeTruthy();
  expect(screen.getAllByRole("heading", { level: 3 }).map((name) => name.textContent)).toEqual([
    "Unnamed agent (no public profile yet)",
    "Acme Coder",
    "Acme Writer",
  ]);
  // Each card's provider field leads back here.
  for (const card of cards) {
    expect(within(within(card).getByTestId("asp")).getByRole("link").getAttribute("href")).toBe(
      `/providers/${ACME}`,
    );
  }
  expect(screen.queryByTestId("team-badge")).toBeNull();
});

test("provider_page_adds_up_the_bonds_the_api_gives", async () => {
  const bonded = (who: AgentSummary, status: string, amount: string) => ({
    ...who,
    status,
    bond_token: TOKEN,
    bond_amount: amount,
    claimable_at: null,
  });
  fakeApi(() =>
    agentsPage([
      bonded(coder, "active", "5000000"),
      bonded(writer, "unregistering", "5000000"),
      bonded(analyst, "retired", "5000000"),
    ] as AgentSummary[]),
  );
  render(<ProviderView account={ACME} />);

  // Locked by the active and the unregistering agent; the retired one has its bond back.
  const bonds = await screen.findByTestId("stat-bonds");
  expect(
    within(bonds)
      .getAllByTestId("amount")
      .map((amount) => amount.textContent),
  ).toEqual(["10.00 tUSDC"]);
});

test("provider_page_of_the_team_carries_the_label", async () => {
  fakeApi(() => agentsPage([judge]));
  render(<ProviderView account={TEAM} />);

  await screen.findAllByTestId("agent-card");
  const head = screen.getByRole("banner");
  expect(within(head).getByTestId("team-badge").textContent).toBe("Run by Tender team");
});

test("provider_page_of_agents_that_have_done_nothing_yet_says_it_in_one_line", async () => {
  fakeApi(() => agentsPage([analyst]));
  render(<ProviderView account={ACME} />);

  expect((await screen.findByTestId("record-line")).textContent).toBe(
    "1 agent·0 entries·0 wins·earned nothing yet",
  );
  expect(screen.queryByLabelText("Its agents together")).toBeNull();
  // The agent's card says the same in its own line.
  expect(within(screen.getByTestId("agent-card")).getByTestId("agent-figures").textContent).toBe(
    "0 entries·0 reveals·0 wins·earned nothing yet",
  );
});

test("provider_page_with_no_agents_says_so_and_why_an_account_can_t_be_one", async () => {
  fakeApi(() => agentsPage([]));
  const first = render(<ProviderView account={ACME} />);
  expect((await screen.findByTestId("no-fleet")).textContent).toBe(
    "No agents run under this account yet.",
  );
  expect(screen.queryByLabelText("Its agents together")).toBeNull();
  first.unmount();

  render(<ProviderView account="near" />);
  expect((await screen.findByTestId("no-fleet")).textContent).toContain("two labels or more");
});

test("provider_page_asks_nothing_for_an_address_that_is_no_account", async () => {
  const { calls } = fakeApi(() => agentsPage([writer]));
  render(<ProviderView account="../../v1/health" />);

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Provider");
  expect(screen.getByText("There is no provider with this account.")).toBeTruthy();
  await settle();
  expect(calls).toEqual([]);
});

test("provider_page_reads_every_page_of_its_agents_and_retries", async () => {
  let fail = true;
  const { calls } = fakeApi((url) => {
    if (fail) return serverFault();
    return url.searchParams.get("cursor") === null
      ? agentsPage([coder], `coder.${ACME}`)
      : agentsPage([writer]);
  });
  render(<ProviderView account={ACME} />);

  const error = await screen.findByTestId("error-state");
  fail = false;
  await userEvent.click(within(error).getByRole("button", { name: "Retry" }));
  expect(await screen.findAllByTestId("agent-card")).toHaveLength(2);
  expect(calls.filter((call) => call.startsWith("/v1/agents")).slice(-2)).toEqual([
    `/v1/agents?asp=${ACME}&limit=50`,
    `/v1/agents?asp=${ACME}&limit=50&cursor=coder.${ACME}`,
  ]);
});

test("provider_page_lists_its_services_for_hire_as_the_services_page_does", async () => {
  const listing: Service = {
    id: "3",
    provider: ACME,
    agent: `writer.${ACME}`,
    title: "Summarise a filing",
    description: "Five lines.",
    tags: ["research"],
    category: "research",
    output_format: "text",
    token: TOKEN,
    price: "2500000",
    commit_secs: 600,
    reveal_secs: 300,
    pick_secs: 600,
    verification: { kind: "hirer" },
    status: "active",
    available: true,
    is_team: false,
    created_at: "2026-11-04T09:00:00.000Z",
    updated_at: "2026-11-04T09:00:00.000Z",
    agent_record: writer,
  };
  const { calls } = fakeApi((url) =>
    url.pathname === "/v1/services"
      ? json({ services: [listing], next_cursor: null })
      : agentsPage([writer]),
  );
  render(<ProviderView account={ACME} />);

  const [card] = await screen.findAllByTestId("service-card");
  expect(calls).toContain(`/v1/services?provider=${ACME}&limit=50`);
  expect(screen.getByRole("heading", { level: 2, name: "Its services" })).toBeTruthy();
  expect(within(card as HTMLElement).getByRole("heading", { level: 3 }).textContent).toBe(
    "Summarise a filing",
  );
  expect(within(card as HTMLElement).getByTestId("service-price").textContent).toBe(
    "Price: 2.50 tUSDC",
  );

  // A read that fails says so in its own place, and the agents stay.
  vi.unstubAllGlobals();
  let fail = true;
  fakeApi((url) =>
    url.pathname === "/v1/services"
      ? fail
        ? serverFault()
        : json({ services: [listing], next_cursor: null })
      : agentsPage([writer]),
  );
  render(<ProviderView account={ACME} />);
  const error = await screen.findByTestId("error-state");
  expect(screen.getAllByTestId("agent-card").length).toBeGreaterThan(0);
  fail = false;
  await userEvent.click(within(error).getByRole("button", { name: "Retry" }));
  expect((await screen.findAllByTestId("service-card")).length).toBeGreaterThan(1);
});

// ---- The agent card's provider ------------------------------------------------------------------

test("agent_card_links_its_provider_to_the_provider_s_page_above_the_card_s_link", () => {
  render(
    <ul>
      <AgentCard agent={writer} />
      <AgentCard agent={carol} />
    </ul>,
  );
  const [mine, hers] = screen.getAllByTestId("agent-card") as [HTMLElement, HTMLElement];
  const asp = within(mine).getByTestId("asp");
  expect(asp.textContent).toBe(ACME);
  const link = within(asp).getByRole("link", { name: ACME });
  expect(link.getAttribute("href")).toBe(`/providers/${ACME}`);
  // It sits above the card's own link, which stretches over the card, so a click reaches it.
  expect(link.className).toContain("relative z-10");
  // No provider: no link.
  expect(within(within(hers).getByTestId("asp")).queryByRole("link")).toBeNull();
  // A card's name is a level-2 heading by default.
  expect(within(mine).getByRole("heading", { level: 2 }).textContent).toBe("Acme Writer");
});

test("provider_page_says_by_its_record_when_it_stopped_reading", async () => {
  // Every page has one more after it: the page stops after ten, and the record says it covers
  // only the agents read, next to the figures, as well as under the cards.
  fakeApi((_url, call) =>
    agentsPage([{ ...writer, account: `w${call}.${ACME}` }], `w${call}.${ACME}`),
  );
  render(<ProviderView account={ACME} />);

  const note = await screen.findByTestId("record-truncated");
  expect(note.textContent).toBe("Counts and totals cover the first 10 agents.");
  const record = screen.getByLabelText("Its agents together");
  // It sits with the record, before the agents' section.
  expect(record.parentElement?.contains(note)).toBe(true);
  expect(screen.getByTestId("agents-truncated").textContent).toBe("Showing the first 10 agents.");
});
