import type { AgentDetailResponse, AgentSummary, Phase, Service } from "@tender/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AgentDirectory } from "../components/AgentDirectory";
import { AgentView } from "../components/AgentView";
import { RPC_ORIGIN, type RpcCalls, rpcAnswer } from "./fakeRpc";
import { agent, HASH_C, summary, TOKEN } from "./tasks";

// The agent directory and an agent's page over a fake API. The directory's filter is in the
// address, so the tests hand it the search parameters a page would have.

const search = vi.hoisted(() => ({ current: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => search.current }));

const ALICE = "alice.testnet";
const OTHER_TOKEN = "other.testnet";

const alice = agent({
  account: ALICE,
  name: "Alice Extractor",
  asp: "provider.testnet",
  tags: ["extraction", "json"],
  entries: 5,
  reveals: 4,
  wins: 2,
  // Two tokens: what an agent earned is shown a token at a time and never added up.
  earned: { [TOKEN]: "2500000", [OTHER_TOKEN]: "7" },
  picks_made: 0,
  voids_after_reveals: 0,
  is_team: false,
});
const carol = agent({
  account: "carol.testnet",
  name: "Carol Research",
  asp: null,
  tags: ["research", "summaries"],
  entries: 1,
  reveals: 0,
  wins: 0,
  earned: {},
  picks_made: 3,
  voids_after_reveals: 0,
  is_team: false,
});
// The team's own judge: `agent()` is the Tender Judge, run by the team.
const judge = agent();

const RECENT: AgentDetailResponse["recent_entries"] = [
  {
    task_id: "2",
    title: "Regex for valid NEAR account IDs",
    phase: "open",
    revealed: false,
    won: false,
  },
  {
    task_id: "1",
    title: "Extract fields from an invoice",
    phase: "settled",
    revealed: true,
    won: true,
  },
  { task_id: "9", title: null, phase: "expired", revealed: false, won: false },
];

const LINEAGE = [
  summary({
    id: "12",
    title: "Check every rule of the account id",
    poster: ALICE,
    parent: "2",
    phase: "revealing",
    reward: "500000",
  }),
  summary({
    id: "11",
    title: "Collect sample invoices",
    poster: ALICE,
    parent: null,
    phase: "settled",
    reward: "1500000",
  }),
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const notFound = () => json({ error: "not_found", message: "no such route" }, 404);
const serverFault = () => json({ error: "internal", message: "db down at 10.0.3.7" }, 500);

const agentsPage = (agents: AgentSummary[], next: string | null = null) =>
  json({ agents, next_cursor: next });
const detailOf = (who: AgentSummary, recent = RECENT) =>
  json({ agent: who, recent_entries: recent });
const tasksPage = (tasks: unknown[], next: string | null = null) =>
  json({ tasks, next_cursor: next });

/** The services the API lists, for the directory's prices and an agent's page: none by default. */
const listed = vi.hoisted(() => ({ current: [] as unknown[] }));

/**
 * A `fetch` that hands each request, as a URL, to `handler`, and writes down path and query. The
 * services, which the directory and an agent's page read beside the agents, are answered from
 * `listed` and written down apart (`serviceCalls`), so that `calls` are the agents' reads. So are
 * the reads of the chain that an agent's Safety section makes (`rpcCalls`, from an empty chain).
 */
function fakeApi(handler: (url: URL, call: number) => Response | Promise<Response>) {
  const calls: string[] = [];
  const serviceCalls: string[] = [];
  const rpcCalls: RpcCalls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === RPC_ORIGIN) return rpcAnswer(String(init?.body ?? ""), {}, rpcCalls);
    if (url.pathname === "/v1/services") {
      serviceCalls.push(`${url.pathname}${url.search}`);
      const agent = url.searchParams.get("agent");
      const services = listed.current.filter(
        (one) => agent === null || (one as Service).agent === agent,
      );
      return json({ services, next_cursor: null });
    }
    calls.push(`${url.pathname}${url.search}`);
    return handler(url, calls.length);
  });
  return { calls, serviceCalls, rpcCalls };
}

/** A service of `agent`'s at `price` (tUSDC's smallest unit), as the API lists one. */
function serviceOf(agentAccount: string, id: string, price: string): Service {
  return {
    id,
    provider: agentAccount,
    agent: agentAccount,
    title: `Service ${id}`,
    description: "Does one thing well.",
    tags: [],
    category: "research",
    output_format: "text",
    token: TOKEN,
    price,
    commit_secs: 3_600,
    reveal_secs: 1_800,
    pick_secs: 3_600,
    verification: { kind: "hirer" },
    status: "active",
    available: true,
    is_team: false,
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    agent_record: null,
  };
}

/** A gate: what waits on `opens` goes on when `open` is called. */
function gate() {
  let open: () => void = () => {};
  const opens = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opens, open: () => open() };
}

/** Lets what is under way finish, for a test that looks for something that must not happen. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  search.current = new URLSearchParams();
  listed.current = [];
});

/** The card whose name (its heading) is `name`. */
const cardOf = (cards: HTMLElement[], name: string): HTMLElement => {
  const found = cards.find((card) => within(card).queryByRole("heading", { name }) !== null);
  if (found === undefined) throw new Error(`no card for ${name}`);
  return found;
};

// ---- The directory ----------------------------------------------------------------------------

test("directory_shows_each_agent_with_one_line_of_what_it_has_done", async () => {
  fakeApi(() => agentsPage([alice, carol, judge]));
  render(<AgentDirectory />);

  const cards = await screen.findAllByTestId("agent-card");

  expect(cards).toHaveLength(3);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "Browse agents. Hire one that fits.",
  );
  const mine = cardOf(cards, "Alice Extractor");
  // The card's link is its round arrow, named for the agent, and it stretches over the card.
  const link = within(mine).getByRole("link", { name: "Open agent: Alice Extractor" });
  expect(link.getAttribute("href")).toBe(`/agents/${ALICE}`);
  expect(link.className).toContain("after:inset-0");
  expect(within(mine).getByTestId("agent-account").textContent).toBe(ALICE);
  // One line: wins, entries, and what it earned in the tokens the app knows (its page has all).
  expect(within(mine).getByTestId("agent-stats").textContent).toBe(
    "2 wins · 5 entries · 2.50 tUSDC earned",
  );
  // The rest is on its page, not on its card.
  for (const id of ["asp", "picks-made", "voids-after-reveals", "agent-verifier-record"]) {
    expect(within(mine).queryByTestId(id), id).toBeNull();
  }
  expect(within(cardOf(cards, "Carol Research")).getByTestId("agent-stats").textContent).toBe(
    "0 wins · 1 entry",
  );
  expect(within(cardOf(cards, "Tender Judge")).getByTestId("agent-stats").textContent).toBe(
    "No entries yet",
  );
});

test("directory_shows_the_cheapest_service_of_an_agent_that_lists_one", async () => {
  listed.current = [
    serviceOf(ALICE, "1", "3000000"),
    serviceOf(ALICE, "2", "2000000"),
    // A token the app has no decimals for is not compared with the others.
    { ...serviceOf(ALICE, "3", "5"), token: OTHER_TOKEN },
  ];
  const api = fakeApi(() => agentsPage([alice, carol]));
  render(<AgentDirectory />);

  const cards = await screen.findAllByTestId("agent-card");
  const mine = cardOf(cards, "Alice Extractor");
  await waitFor(() =>
    expect(within(mine).getByTestId("agent-from").textContent).toBe("From 2.00 tUSDC / task"),
  );
  // An agent that lists none shows no price.
  expect(within(cardOf(cards, "Carol Research")).queryByTestId("agent-from")).toBeNull();
  // The services are read once, beside the agents.
  expect(api.serviceCalls).toEqual(["/v1/services?limit=50"]);
});

test("directory_shows_its_agents_without_prices_when_the_services_can_t_be_read", async () => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/services") return serverFault();
    return agentsPage([alice]);
  });
  render(<AgentDirectory />);
  const [card] = await screen.findAllByTestId("agent-card");
  await settle();
  expect(within(card as HTMLElement).queryByTestId("agent-from")).toBeNull();
  expect(screen.queryByTestId("error-state")).toBeNull();
});

test("directory_marks_the_agents_the_team_runs_and_only_those", async () => {
  fakeApi(() => agentsPage([alice, carol, judge]));
  render(<AgentDirectory />);

  const cards = await screen.findAllByTestId("agent-card");

  const badges = screen.getAllByTestId("team-badge");
  expect(badges).toHaveLength(1);
  expect(badges[0]?.textContent).toBe("Run by Tender team");
  expect(cardOf(cards, "Tender Judge").contains(badges[0] as HTMLElement)).toBe(true);
  expect(within(cardOf(cards, "Alice Extractor")).queryByTestId("team-badge")).toBeNull();
});

test("directory_calls_an_agent_with_no_public_profile_by_the_first_part_of_its_account", async () => {
  fakeApi(() =>
    agentsPage([agent({ account: "analyst.acme.testnet", name: null, tags: [], is_team: false })]),
  );
  render(<AgentDirectory />);

  const [card] = await screen.findAllByTestId("agent-card");

  expect(within(card as HTMLElement).getByRole("heading").textContent).toBe("analyst");
  expect(
    within(card as HTMLElement)
      .getByRole("link", { name: "Open agent: analyst (analyst.acme.testnet)" })
      .getAttribute("href"),
  ).toBe("/agents/analyst.acme.testnet");
  expect(card?.textContent).not.toContain("Unnamed agent");
});

test("directory_searches_by_name_or_account_over_what_it_has", async () => {
  const api = fakeApi(() => agentsPage([alice, carol, judge]));
  const user = userEvent.setup();
  render(<AgentDirectory />);
  await screen.findAllByTestId("agent-card");
  const field = screen.getByRole("searchbox", { name: "Search by name or account" });

  await user.type(field, "carol");
  expect(screen.getAllByTestId("agent-card").map((card) => card.textContent)).toEqual([
    expect.stringContaining("Carol Research"),
  ]);
  expect(screen.getByText("1 shown")).toBeTruthy();

  // An account's words count too, in any case.
  await user.clear(field);
  await user.type(field, "TENDER-TEAM");
  expect(screen.getAllByTestId("agent-card")).toHaveLength(1);
  expect(within(screen.getByTestId("agent-card")).getByRole("heading").textContent).toBe(
    "Tender Judge",
  );

  // Nothing matches: one line, and the way back to every agent.
  await user.clear(field);
  await user.type(field, "nobody at all");
  expect(screen.queryAllByTestId("agent-card")).toEqual([]);
  expect(screen.getByTestId("no-matching-agents").textContent).toContain("No agent matches.");
  // The search is over what was read: no request is made for it.
  expect(api.calls).toEqual(["/v1/agents?limit=50"]);
});

test("directory_sorts_the_newest_first_or_the_most_wins_first", async () => {
  const older = agent({ ...carol, registered_height: "50", wins: 9 });
  const newer = agent({ ...alice, registered_height: "300", wins: 2 });
  fakeApi(() => agentsPage([older, judge, newer]));
  const user = userEvent.setup();
  render(<AgentDirectory />);
  await screen.findAllByTestId("agent-card");
  const names = () =>
    screen
      .getAllByTestId("agent-card")
      .map((card) => within(card).getByRole("heading").textContent);
  const order = within(screen.getByRole("group", { name: "Order" }));

  expect(order.getByRole("button", { name: "Newest" }).getAttribute("aria-pressed")).toBe("true");
  expect(names()).toEqual(["Alice Extractor", "Tender Judge", "Carol Research"]);

  await user.click(order.getByRole("button", { name: "Most wins" }));

  expect(names()).toEqual(["Carol Research", "Alice Extractor", "Tender Judge"]);
});

test("directory_narrows_by_the_tag_in_the_address_and_clear_takes_it_off", async () => {
  search.current = new URLSearchParams("tag=%20Research%20");
  fakeApi(() => agentsPage([alice, carol, judge]));
  render(<AgentDirectory />);

  const cards = await screen.findAllByTestId("agent-card");

  // A tag of an older link is read as a tag is written, and still narrows the list.
  expect(cards).toHaveLength(1);
  expect(within(cards[0] as HTMLElement).getByRole("heading").textContent).toBe("Carol Research");
  expect(screen.getByRole("link", { name: "Clear" }).getAttribute("href")).toBe("/agents");
  // No row of tags to choose from.
  expect(screen.queryByRole("navigation", { name: "Filter by tag" })).toBeNull();
});

test("directory_says_so_when_no_agent_has_the_tag", async () => {
  search.current = new URLSearchParams("tag=nothing");
  fakeApi(() => agentsPage([alice, carol, judge]));
  render(<AgentDirectory />);

  const empty = await screen.findByTestId("no-matching-agents");
  expect(empty.textContent).toContain("No agent has the tag nothing.");
  expect(screen.getByRole("link", { name: "Show all agents" }).getAttribute("href")).toBe(
    "/agents",
  );
  expect(screen.queryAllByTestId("agent-card")).toEqual([]);
});

test("directory_says_back_only_what_is_a_tag", async () => {
  fakeApi(() => agentsPage([alice, carol, judge]));
  const tags: Array<[string, string]> = [
    // A tag as the board takes it is said back, in the case it is written in.
    ["nothing", "No agent has the tag nothing."],
    ["Nothing", "No agent has the tag nothing."],
    ["z".repeat(24), `No agent has the tag ${"z".repeat(24)}.`],
    // The address can hold anything else, of any length, and none of it is said back.
    ["z".repeat(25), "No agent matches."],
    ["x".repeat(200), "No agent matches."],
    ["<b>bold</b>", "No agent matches."],
    ["two words", "No agent matches."],
    ["under_score", "No agent matches."],
  ];

  for (const [tag, said] of tags) {
    search.current = new URLSearchParams({ tag });
    const { unmount } = render(<AgentDirectory />);

    const empty = await screen.findByTestId("no-matching-agents");

    expect(within(empty).getByText(said), tag).toBeTruthy();
    expect(empty.textContent, tag).not.toContain("<b>");
    expect(empty.textContent, tag).not.toContain("x".repeat(200));
    unmount();
  }
});

test("directory_with_no_agents_says_so", async () => {
  fakeApi(() => agentsPage([]));
  render(<AgentDirectory />);

  expect((await screen.findByText("No agents yet.")).tagName).toBe("P");
  expect(screen.getByRole("link", { name: "Add an agent" }).getAttribute("href")).toBe(
    "/my-agents/new",
  );
  expect(screen.queryByRole("searchbox")).toBeNull();
});

test("directory_reads_every_page_before_it_shows_any", async () => {
  const api = fakeApi((url) =>
    url.searchParams.get("cursor") === null ? agentsPage([alice], ALICE) : agentsPage([carol]),
  );
  render(<AgentDirectory />);

  const cards = await screen.findAllByTestId("agent-card");

  expect(cards).toHaveLength(2);
  expect(api.calls).toEqual(["/v1/agents?limit=50", `/v1/agents?limit=50&cursor=${ALICE}`]);
  expect(screen.getByText("2 shown")).toBeTruthy();
  expect(screen.queryByTestId("agents-truncated")).toBeNull();
});

test("directory_stops_at_its_page_limit_and_says_so", async () => {
  let made = 0;
  const api = fakeApi(() => {
    made++;
    return agentsPage(
      [agent({ account: `agent${made}.testnet`, name: `Agent ${made}` })],
      `agent${made}.testnet`,
    );
  });
  render(<AgentDirectory maxPages={2} />);

  const cards = await screen.findAllByTestId("agent-card");

  expect(cards).toHaveLength(2);
  expect(api.calls).toHaveLength(2);
  expect(screen.getByTestId("agents-truncated").textContent).toBe("Showing the first 2 agents.");
});

test("directory_stops_asking_for_pages_when_the_page_is_gone", async () => {
  const wait = gate();
  const api = fakeApi(async () => {
    await wait.opens;
    // Always another page: left alone, the loop would go on to its limit.
    return agentsPage([agent({ account: "more.testnet", name: "More" })], "more.testnet");
  });
  const view = render(<AgentDirectory />);
  await waitFor(() => expect(api.calls).toHaveLength(1));

  view.unmount();
  wait.open();
  await settle();

  expect(api.calls).toHaveLength(1);
});

test("directory_stops_the_read_that_a_newer_one_takes_over_from", async () => {
  // Strict mode starts the read twice and drops the first. Only the second goes on to page two.
  const api = fakeApi((url) =>
    url.searchParams.get("cursor") === null ? agentsPage([alice], ALICE) : agentsPage([carol]),
  );
  render(
    <StrictMode>
      <AgentDirectory />
    </StrictMode>,
  );

  expect(await screen.findAllByTestId("agent-card")).toHaveLength(2);

  expect(api.calls).toEqual([
    "/v1/agents?limit=50",
    "/v1/agents?limit=50",
    `/v1/agents?limit=50&cursor=${ALICE}`,
  ]);
});

test("directory_failing_says_why_and_a_retry_reads_again", async () => {
  const api = fakeApi((_, call) => (call === 1 ? serverFault() : agentsPage([alice])));
  const user = userEvent.setup();
  render(<AgentDirectory />);

  const failure = await screen.findByTestId("error-state");

  // The reason is in words; what the server said of itself is not on the page.
  expect(failure.textContent).toContain("The Tender API had a problem (status 500).");
  expect(document.body.textContent).not.toContain("10.0.3.7");
  expect(console.error).toHaveBeenCalledTimes(1);

  await user.click(screen.getByRole("button", { name: "Retry" }));

  expect(await screen.findAllByTestId("agent-card")).toHaveLength(1);
  expect(screen.queryByTestId("error-state")).toBeNull();
  expect(api.calls).toHaveLength(2);
});

test("directory_shows_what_agents_wrote_as_text", async () => {
  const markup = '<img src=x onerror="alert(1)">';
  fakeApi(() => agentsPage([agent({ account: "mallory.testnet", name: markup, tags: ["x"] })]));
  const { container } = render(<AgentDirectory />);

  const [card] = await screen.findAllByTestId("agent-card");

  expect(within(card as HTMLElement).getByRole("heading").textContent).toBe(markup);
  expect(container.querySelector("img")).toBeNull();
});

// ---- An agent's page --------------------------------------------------------------------------

/** The routes of an agent's page: the agent, and the tasks it posted. */
const routes =
  (who: AgentSummary = alice, tasks: () => Response = () => tasksPage(LINEAGE), recent = RECENT) =>
  (url: URL) => {
    if (url.pathname === `/v1/agents/${who.account}`) return detailOf(who, recent);
    if (url.pathname === "/v1/tasks") return tasks();
    return notFound();
  };

/**
 * The heading of the agent's page once the agent is in. Before then the heading is the account, so
 * that a page in any state has one.
 */
const loadedHeading = async () => {
  await screen.findByTestId("account");
  return screen.getByRole("heading", { level: 1 });
};

test("agent_page_shows_the_profile_the_recent_entries_and_the_lineage", async () => {
  const api = fakeApi(routes());
  render(<AgentView account={ALICE} />);

  expect(screen.getByRole("status").textContent).toBe("Loading agent…");
  const title = await loadedHeading();

  expect(title.textContent).toBe("Alice Extractor");
  // Breadcrumbs from the Marketplace, the last step the page itself.
  const trail = within(screen.getByRole("navigation", { name: "Breadcrumbs" }));
  expect(trail.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
    "/tasks",
    "/agents",
  ]);
  expect(trail.getByText("Alice Extractor").getAttribute("aria-current")).toBe("page");
  expect(screen.getByTestId("account").textContent).toBe(ALICE);
  expect(screen.queryByTestId("team-badge")).toBeNull();
  // The four stat cards, and the strip of its provider, its record as a checker and when it joined.
  expect(screen.getByTestId("wins").textContent).toBe("2");
  expect(screen.getByTestId("entries").textContent).toBe("5");
  expect(screen.getByTestId("reveals").textContent).toBe("4");
  expect(screen.getByRole("button", { name: "Copy account" })).toBeTruthy();
  expect(screen.getByTestId("asp").textContent).toBe("provider.testnet");
  expect(within(screen.getByTestId("asp")).getByRole("link").getAttribute("href")).toBe(
    "/providers/provider.testnet",
  );
  const record = within(screen.getByTestId("agent-verifier-record"));
  expect(record.getByTestId("picks-made").textContent).toBe("0");
  expect(record.getByTestId("voids-after-reveals").textContent).toBe("0");
  // The numbered sections.
  for (const name of ["Services", "Recent tasks", "Record", "Safety"]) {
    expect(screen.getByRole("heading", { level: 2, name }), name).toBeTruthy();
  }
  expect(await screen.findByTestId("no-agent-services")).toBeTruthy();
  expect(
    within(screen.getByTestId("earned"))
      .getAllByTestId("amount")
      .map((amount) => amount.textContent),
  ).toEqual(["2.50 tUSDC", `7 ${OTHER_TOKEN}`]);
  // Where the profile is, and what it hashes to.
  expect(screen.getByText("Registered at block 100")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: `Open profile document of ${ALICE}` }).getAttribute("rel"),
  ).toBe("noopener noreferrer nofollow");
  expect(screen.getByText(`sha256 ${HASH_C}`)).toBeTruthy();

  // The latest entries as the API gave them: the task, its phase, revealed, won.
  const entries = screen.getAllByTestId("recent-entry");
  expect(entries).toHaveLength(3);
  expect(
    within(entries[0] as HTMLElement)
      .getByRole("link")
      .getAttribute("href"),
  ).toBe("/tasks/2");
  expect(entries[0]?.textContent).toContain("Regex for valid NEAR account IDs");
  expect(within(entries[0] as HTMLElement).getByTestId("phase-chip").textContent).toBe("Open");
  expect(within(entries[0] as HTMLElement).getByTestId("revealed").textContent).toBe(
    "Revealed: no",
  );
  // The task is open: nobody has been picked, so "no" would read as a loss.
  expect(within(entries[0] as HTMLElement).getByTestId("won").textContent).toBe(
    "Won: not decided yet",
  );
  expect(within(entries[1] as HTMLElement).getByTestId("phase-chip").textContent).toBe("Settled");
  expect(within(entries[1] as HTMLElement).getByTestId("revealed").textContent).toBe(
    "Revealed: yes",
  );
  expect(within(entries[1] as HTMLElement).getByTestId("won").textContent).toBe("Won: yes");
  // A task with no public brief has no title to show: the stand-in is the one every list uses, and
  // its number is beside it. It expired with no pick, which is decided: the agent did not win it.
  expect(within(entries[2] as HTMLElement).getByRole("link").textContent).toBe(
    "Untitled task (no public brief yet)",
  );
  expect(within(entries[2] as HTMLElement).getByText("#9")).toBeTruthy();
  expect(within(entries[2] as HTMLElement).getByTestId("won").textContent).toBe("Won: no");

  // The tasks it posted, each with the task it is a subtask of, if it is one.
  const lineage = await screen.findAllByTestId("lineage-task");
  expect(screen.getByRole("heading", { level: 3, name: "Tasks it posted" })).toBeTruthy();
  expect(lineage).toHaveLength(2);
  expect(lineage[0]?.textContent).toContain("Check every rule of the account id");
  expect(within(lineage[0] as HTMLElement).getByTestId("phase-chip").textContent).toBe("Revealing");
  expect(within(lineage[0] as HTMLElement).getByTestId("amount").textContent).toBe("0.50 tUSDC");
  const parent = within(lineage[0] as HTMLElement).getByTestId("parent-link");
  expect(parent.textContent).toBe("Task #2");
  expect(parent.getAttribute("href")).toBe("/tasks/2");
  expect(lineage[1]?.textContent).toContain("Collect sample invoices");
  expect(within(lineage[1] as HTMLElement).queryByTestId("parent-link")).toBeNull();
  expect(screen.queryByTestId("lineage-more")).toBeNull();

  // The agent is read first, and its tasks and its services after it, by its account.
  expect(api.calls).toEqual([`/v1/agents/${ALICE}`, `/v1/tasks?poster=${ALICE}&limit=50`]);
  expect(api.serviceCalls).toEqual([`/v1/services?agent=${ALICE}&limit=50`]);
});

test("agent_page_lists_its_services_and_says_what_the_cheapest_costs", async () => {
  listed.current = [serviceOf(ALICE, "1", "3000000"), serviceOf(ALICE, "2", "2000000")];
  fakeApi(routes());
  render(<AgentView account={ALICE} />);
  await loadedHeading();

  const cards = await screen.findAllByTestId("service-card");
  expect(cards).toHaveLength(2);
  // Under the section's h2, each service's title is an h3.
  expect(within(cards[0] as HTMLElement).getByRole("heading", { level: 3 }).textContent).toBe(
    "Service 1",
  );
  // The way down to them, with the cheapest price.
  const pill = screen.getByRole("link", { name: /See services/ });
  expect(pill.getAttribute("href")).toBe("#agent-services");
  expect(within(pill).getByTestId("agent-from").textContent).toBe("From 2.00 tUSDC / task");
});

test("agent_page_tells_its_safety_section_of_the_x402_apis_it_lists", async () => {
  // One escrow service and one x402 API, which is paid at once, outside the contract.
  const api: Service = {
    ...serviceOf(ALICE, "3", "1000"),
    title: "Inventory API",
    output_format: "json",
    commit_secs: 0,
    reveal_secs: 0,
    pick_secs: 0,
    verification: { kind: "none" },
    payment_mode: "x402",
    x402: {
      endpoint: "https://provider.example/inventory",
      network: "near:testnet",
      pay_to: ALICE,
      max_timeout_seconds: 60,
    },
  };
  listed.current = [serviceOf(ALICE, "1", "3000000"), api];
  fakeApi(routes());
  render(<AgentView account={ALICE} />);
  await loadedHeading();

  expect(await screen.findAllByTestId("service-card")).toHaveLength(2);
  await waitFor(() =>
    expect(screen.getByTestId("safety-hiring").textContent).toContain("It lists an x402 API."),
  );
});

test("agent_page_says_when_an_agent_runs_under_no_provider_and_has_earned_nothing", async () => {
  // Facts the directory's card used to carry: here now, for an agent with no provider and no pay.
  fakeApi(routes(carol));
  render(<AgentView account={carol.account} />);
  await loadedHeading();

  const asp = screen.getByTestId("asp");
  expect(asp.textContent).toBe("none");
  // No provider: no link.
  expect(within(asp).queryByRole("link")).toBeNull();
  expect(screen.getByTestId("earned").textContent).toBe("Nothing yet");
  const record = within(screen.getByTestId("agent-verifier-record"));
  expect(record.getByTestId("picks-made").textContent).toBe("3");
});

test("agent_page_calls_an_agent_with_no_profile_by_its_account_s_first_part", async () => {
  fakeApi(routes(agent({ ...alice, name: null })));
  render(<AgentView account={ALICE} />);
  expect((await loadedHeading()).textContent).toBe("alice");
  expect(screen.getByText(/No public profile yet/)).toBeTruthy();
});

test("agent_page_does_not_call_a_task_nobody_has_picked_a_loss", async () => {
  const entry = (task_id: string, phase: Phase, won = false) => ({
    task_id,
    title: `A task that is ${phase}`,
    phase,
    revealed: true,
    won,
  });
  fakeApi(
    routes(alice, () => tasksPage([]), [
      entry("1", "open"),
      entry("2", "revealing"),
      entry("3", "judging"),
      entry("4", "fallback"),
      entry("5", "expired"),
      entry("6", "settled"),
      entry("7", "settled", true),
    ]),
  );
  render(<AgentView account={ALICE} />);

  await screen.findAllByTestId("recent-entry");

  // The API's `won` is false until a pick, so only a task with its outcome says "no".
  expect(screen.getAllByTestId("won").map((won) => won.textContent)).toEqual([
    "Won: not decided yet",
    "Won: not decided yet",
    "Won: not decided yet",
    "Won: not decided yet",
    "Won: no",
    "Won: no",
    "Won: yes",
  ]);
});

test("agent_page_marks_an_agent_the_team_runs", async () => {
  fakeApi(routes(judge));
  render(<AgentView account={judge.account} />);

  await loadedHeading();

  expect(within(screen.getByTestId("account")).getByTestId("team-badge").textContent).toBe(
    "Run by Tender team",
  );
});

test("agent_page_for_an_account_nobody_registered_is_not_found_and_not_an_error", async () => {
  const api = fakeApi(() => notFound());
  render(<AgentView account="nobody.testnet" />);

  expect((await screen.findByText("There is no agent with this account.")).tagName).toBe("P");

  expect(screen.queryByTestId("error-state")).toBeNull();
  expect(console.error).not.toHaveBeenCalled();
  // Its tasks are not asked for: there is no agent to ask about.
  expect(api.calls).toEqual(["/v1/agents/nobody.testnet"]);
});

test("agent_page_for_text_that_is_no_account_asks_for_nothing", async () => {
  const api = fakeApi(() => notFound());
  for (const address of ["Not-An-Account", "..", "a/b", "a b", ""]) {
    const { unmount } = render(<AgentView account={address} />);

    expect(await screen.findByText("There is no agent with this account."), address).toBeTruthy();
    unmount();
  }

  expect(api.calls).toEqual([]);
});

test("agent_page_keeps_the_profile_when_the_lineage_cannot_be_read", async () => {
  let asked = 0;
  const api = fakeApi(
    routes(alice, () => {
      asked++;
      return asked === 1 ? serverFault() : tasksPage(LINEAGE);
    }),
  );
  const user = userEvent.setup();
  render(<AgentView account={ALICE} />);

  const lineage = await screen.findByTestId("lineage");
  const failure = await within(lineage).findByTestId("error-state");

  // The profile and the entries are there; only the lineage failed, and has its own retry.
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Alice Extractor");
  expect(screen.getAllByTestId("recent-entry")).toHaveLength(3);
  expect(screen.getAllByTestId("error-state")).toHaveLength(1);
  expect(failure.textContent).toContain("The Tender API had a problem (status 500).");

  await user.click(within(lineage).getByRole("button", { name: "Retry" }));

  expect(await screen.findAllByTestId("lineage-task")).toHaveLength(2);
  expect(screen.queryByTestId("error-state")).toBeNull();
  expect(api.calls.filter((call) => call.startsWith("/v1/agents/"))).toHaveLength(1);
});

test("agent_page_failing_says_why_and_a_retry_reads_again", async () => {
  let asked = 0;
  const api = fakeApi((url) => {
    if (!url.pathname.startsWith("/v1/agents/")) return tasksPage([]);
    asked++;
    return asked === 1
      ? json({ error: "unavailable", message: "try later" }, 503)
      : detailOf(alice);
  });
  const user = userEvent.setup();
  render(<AgentView account={ALICE} />);

  expect((await screen.findByTestId("error-state")).textContent).toContain("(status 503)");
  // Its tasks are asked for only once there is an agent.
  expect(api.calls).toEqual([`/v1/agents/${ALICE}`]);
  await user.click(screen.getByRole("button", { name: "Retry" }));

  expect((await loadedHeading()).textContent).toBe("Alice Extractor");
  expect(api.calls.filter((call) => call.startsWith("/v1/agents/"))).toHaveLength(2);
});

// A page has a heading in every state: the account until the agent's own name is known.
test("agent_page_has_a_heading_while_it_loads_when_it_finds_no_agent_and_when_it_fails", async () => {
  let answer: Response | "never" = "never";
  fakeApi(() => (answer === "never" ? new Promise<Response>(() => {}) : answer));
  const first = render(<AgentView account={ALICE} />);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(ALICE);
  expect(screen.getByRole("status").textContent).toBe("Loading agent…");
  first.unmount();

  answer = notFound();
  const second = render(<AgentView account="nobody.testnet" />);
  await screen.findByText("There is no agent with this account.");
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("nobody.testnet");
  second.unmount();

  answer = json({ error: "unavailable", message: "try later" }, 503);
  render(<AgentView account={ALICE} />);
  await screen.findByTestId("error-state");
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(ALICE);
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
});

test("agent_page_heading_for_text_that_is_no_account_is_not_that_text", async () => {
  fakeApi(() => notFound());

  render(<AgentView account="Not An Account" />);

  await screen.findByText("There is no agent with this account.");
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Agent");
});

test("agent_page_says_so_when_there_are_no_entries_and_no_tasks", async () => {
  fakeApi(routes(alice, () => tasksPage([]), []));
  render(<AgentView account={ALICE} />);

  expect(await screen.findByText("No entries yet.")).toBeTruthy();
  expect(await screen.findByText("This agent has not posted any tasks.")).toBeTruthy();

  expect(screen.queryAllByTestId("recent-entry")).toEqual([]);
  expect(screen.queryAllByTestId("lineage-task")).toEqual([]);
});

test("agent_page_says_when_it_shows_only_the_newest_tasks", async () => {
  fakeApi(routes(alice, () => tasksPage(LINEAGE, "10")));
  render(<AgentView account={ALICE} />);

  expect((await screen.findByTestId("lineage-more")).textContent).toBe(
    "Showing the 2 newest tasks.",
  );
});

test("agent_page_links_a_profile_only_if_it_is_a_web_address", async () => {
  fakeApi(routes(agent({ ...alice, profile_uri: "javascript:alert(document.cookie)" })));
  const first = render(<AgentView account={ALICE} />);

  await loadedHeading();

  expect(screen.queryByRole("link", { name: /Open profile document/ })).toBeNull();
  expect(
    screen.getByText("Profile address (not a web link): javascript:alert(document.cookie)"),
  ).toBeTruthy();
  first.unmount();

  fakeApi(
    routes(
      agent({
        ...alice,
        profile_uri: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
      }),
    ),
  );
  render(<AgentView account={ALICE} />);
  await loadedHeading();
  expect(screen.queryByRole("link", { name: /Open profile document/ })).toBeNull();
});

test("agent_page_shows_what_the_agent_wrote_as_text", async () => {
  const markup = '<img src=x onerror="alert(1)">';
  fakeApi(
    routes(
      agent({ ...alice, name: markup }),
      () => tasksPage([summary({ id: "5", title: markup, poster: ALICE })]),
      [{ task_id: "5", title: markup, phase: "open", revealed: false, won: false }],
    ),
  );
  const { container } = render(<AgentView account={ALICE} />);

  expect((await loadedHeading()).textContent).toBe(markup);
  await waitFor(() => expect(screen.getAllByTestId("lineage-task")).toHaveLength(1));

  expect(container.querySelector("img")).toBeNull();
  expect(screen.getAllByText(markup).length).toBeGreaterThanOrEqual(3);
});
