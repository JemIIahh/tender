import type { AgentDetailResponse, AgentSummary, Phase } from "@tender/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AgentDirectory } from "../components/AgentDirectory";
import { UNNAMED_AGENT } from "../components/AgentFacts";
import { AgentView } from "../components/AgentView";
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
});

const cardOf = (cards: HTMLElement[], name: string): HTMLElement => {
  const found = cards.find((card) => within(card).queryByRole("link", { name }) !== null);
  if (found === undefined) throw new Error(`no card for ${name}`);
  return found;
};

// ---- The directory ----------------------------------------------------------------------------

test("directory_shows_each_agent_with_what_it_has_done_and_earned", async () => {
  fakeApi(() => agentsPage([alice, carol, judge]));
  render(<AgentDirectory />);

  const cards = await screen.findAllByTestId("agent-card");

  expect(cards).toHaveLength(3);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Agents");
  const mine = cardOf(cards, "Alice Extractor");
  expect(within(mine).getByRole("link", { name: "Alice Extractor" }).getAttribute("href")).toBe(
    `/agents/${ALICE}`,
  );
  expect(mine.textContent).toContain(ALICE);
  expect(within(mine).getByTestId("asp").textContent).toBe("provider.testnet");
  expect(within(mine).getByTestId("entries").textContent).toBe("5");
  expect(within(mine).getByTestId("reveals").textContent).toBe("4");
  expect(within(mine).getByTestId("wins").textContent).toBe("2");
  expect(
    within(within(mine).getByLabelText("Tags"))
      .getAllByRole("listitem")
      .map((tag) => tag.textContent),
  ).toEqual(["extraction", "json"]);
  expect(within(mine).getByTestId("picks-made").textContent).toBe("0");
  expect(within(mine).getByTestId("voids-after-reveals").textContent).toBe("0");

  // Earned, a token at a time: each is its own line, in its own token, and nothing adds them up.
  const earned = within(within(mine).getByTestId("earned"));
  expect(earned.getAllByTestId("amount").map((amount) => amount.textContent)).toEqual([
    "2.50 tUSDC",
    `7 ${OTHER_TOKEN}`,
  ]);
  expect(earned.getAllByRole("listitem")).toHaveLength(2);

  // An agent that has earned nothing, and one that runs under no provider, say so.
  const hers = cardOf(cards, "Carol Research");
  expect(within(hers).getByTestId("earned").textContent).toBe("Nothing yet");
  expect(within(hers).getByTestId("asp").textContent).toBe("none");
  expect(within(hers).getByTestId("picks-made").textContent).toBe("3");

  // The verifier record is on the card of an agent that has judged.
  const theirs = cardOf(cards, "Tender Judge");
  const record = within(within(theirs).getByTestId("agent-verifier-record"));
  expect(record.getByTestId("picks-made").textContent).toBe("12");
  expect(record.getByTestId("voids-after-reveals").textContent).toBe("1");
});

test("directory_marks_the_agents_the_team_runs_and_only_those", async () => {
  fakeApi(() => agentsPage([alice, carol, judge]));
  render(<AgentDirectory />);

  const cards = await screen.findAllByTestId("agent-card");

  const badges = screen.getAllByTestId("team-badge");
  expect(badges).toHaveLength(1);
  expect(badges[0]?.textContent).toBe("Run by Tender team");
  expect(cardOf(cards, "Tender Judge").contains(badges[0] as HTMLElement)).toBe(true);
  // The provider line names an account and nothing more: the API can't say whose it is.
  expect(within(cardOf(cards, "Alice Extractor")).queryByTestId("team-badge")).toBeNull();
});

test("directory_names_an_agent_with_no_public_profile_as_such", async () => {
  fakeApi(() => agentsPage([agent({ account: "ghost.testnet", name: null, tags: [] })]));
  render(<AgentDirectory />);

  const [card] = await screen.findAllByTestId("agent-card");

  expect(
    within(card as HTMLElement)
      .getByRole("link", { name: UNNAMED_AGENT })
      .getAttribute("href"),
  ).toBe("/agents/ghost.testnet");
  // No tags, no list of them.
  expect(within(card as HTMLElement).queryByLabelText("Tags")).toBeNull();
});

test("directory_filters_by_the_tag_in_the_address_and_offers_the_tags_the_agents_have", async () => {
  search.current = new URLSearchParams("tag=research");
  fakeApi(() => agentsPage([alice, carol, judge]));
  render(<AgentDirectory />);

  const cards = await screen.findAllByTestId("agent-card");

  expect(cards).toHaveLength(1);
  expect(
    within(cards[0] as HTMLElement).getByRole("link", { name: "Carol Research" }),
  ).toBeTruthy();
  // Every tag of every agent, once, in order; each a link to the filtered view.
  const chips = within(screen.getByRole("navigation", { name: "Filter by tag" })).getAllByRole(
    "link",
  );
  expect(chips.map((chip) => [chip.textContent, chip.getAttribute("href")])).toEqual([
    ["All", "/agents"],
    ["extraction", "/agents?tag=extraction"],
    ["json", "/agents?tag=json"],
    ["judge", "/agents?tag=judge"],
    ["research", "/agents?tag=research"],
    ["summaries", "/agents?tag=summaries"],
  ]);
  expect(chips.filter((chip) => chip.getAttribute("aria-current") === "true")).toHaveLength(1);
  expect(screen.getByRole("link", { name: "research" }).getAttribute("aria-current")).toBe("true");
});

test("directory_with_no_tag_marks_all_and_lists_every_agent", async () => {
  fakeApi(() => agentsPage([alice, carol, judge]));
  render(<AgentDirectory />);

  const cards = await screen.findAllByTestId("agent-card");

  expect(cards).toHaveLength(3);
  expect(screen.getByRole("link", { name: "All" }).getAttribute("aria-current")).toBe("true");
});

test("directory_reads_the_tag_as_a_tag_is_written", async () => {
  search.current = new URLSearchParams("tag=%20Research%20");
  fakeApi(() => agentsPage([alice, carol, judge]));
  render(<AgentDirectory />);

  const cards = await screen.findAllByTestId("agent-card");

  expect(cards).toHaveLength(1);
});

test("directory_says_so_when_no_agent_has_the_tag_and_keeps_the_filter", async () => {
  search.current = new URLSearchParams("tag=nothing");
  fakeApi(() => agentsPage([alice, carol, judge]));
  render(<AgentDirectory />);

  expect((await screen.findByTestId("no-agents")).textContent).toBe(
    "No agent has the tag nothing.",
  );

  expect(screen.queryAllByTestId("agent-card")).toEqual([]);
  // The way back is still there.
  expect(screen.getByRole("link", { name: "All" }).getAttribute("href")).toBe("/agents");
});

test("directory_says_back_only_what_is_a_tag", async () => {
  fakeApi(() => agentsPage([alice, carol, judge]));
  const tags: Array<[string, string]> = [
    // A tag as the board takes it is said back, in the case it is written in.
    ["nothing", "No agent has the tag nothing."],
    ["Nothing", "No agent has the tag nothing."],
    ["z".repeat(24), `No agent has the tag ${"z".repeat(24)}.`],
    // The address can hold anything else, of any length, and none of it is said back.
    ["z".repeat(25), "No agent has that tag."],
    ["x".repeat(200), "No agent has that tag."],
    ["<b>bold</b>", "No agent has that tag."],
    ["two words", "No agent has that tag."],
    ["under_score", "No agent has that tag."],
  ];

  for (const [tag, said] of tags) {
    search.current = new URLSearchParams({ tag });
    const { unmount } = render(<AgentDirectory />);

    const line = await screen.findByTestId("no-agents");

    expect(line.textContent, tag).toBe(said);
    // The line breaks wherever it has to, so that nothing in it makes the page wider.
    expect(line.className, tag).toContain("wrap-anywhere");
    unmount();
  }
});

test("directory_lists_a_tag_an_agent_repeats_each_time_it_is_written", async () => {
  // The contract checks how many tags there are and what they are made of, not that they differ.
  fakeApi(() =>
    agentsPage([agent({ account: "dup.testnet", name: "Dup", tags: ["x", "x", "y"] })]),
  );
  render(<AgentDirectory />);

  const [card] = await screen.findAllByTestId("agent-card");

  const chips = within(within(card as HTMLElement).getByLabelText("Tags")).getAllByRole("listitem");
  expect(chips.map((chip) => chip.textContent)).toEqual(["x", "x", "y"]);
  // The filter lists a tag once. A repeated key is a warning React writes to the console.
  const filter = within(screen.getByRole("navigation", { name: "Filter by tag" }));
  expect(filter.getAllByRole("link").map((link) => link.textContent)).toEqual(["All", "x", "y"]);
  expect(console.error).not.toHaveBeenCalled();
});

test("directory_with_no_agents_says_so", async () => {
  fakeApi(() => agentsPage([]));
  render(<AgentDirectory />);

  expect((await screen.findByText("No agents yet.")).tagName).toBe("P");

  expect(screen.queryByRole("navigation", { name: "Filter by tag" })).toBeNull();
});

test("directory_reads_every_page_before_it_shows_the_tags", async () => {
  const api = fakeApi((url) =>
    url.searchParams.get("cursor") === null ? agentsPage([alice], ALICE) : agentsPage([carol]),
  );
  render(<AgentDirectory />);

  const cards = await screen.findAllByTestId("agent-card");

  expect(cards).toHaveLength(2);
  expect(api.calls).toEqual(["/v1/agents?limit=50", `/v1/agents?limit=50&cursor=${ALICE}`]);
  // A tag of the second page is there to choose.
  expect(screen.getByRole("link", { name: "research" })).toBeTruthy();
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
  expect(screen.getByTestId("account").textContent).toBe(ALICE);
  expect(screen.queryByTestId("team-badge")).toBeNull();
  expect(screen.getByTestId("asp").textContent).toBe("provider.testnet");
  expect(screen.getByTestId("wins").textContent).toBe("2");
  expect(screen.getByTestId("agent-verifier-record")).toBeTruthy();
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
  expect(screen.getByRole("heading", { level: 2, name: "Tasks it posted" })).toBeTruthy();
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

  // The agent is read first, and its tasks after it, by its account.
  expect(api.calls).toEqual([`/v1/agents/${ALICE}`, `/v1/tasks?poster=${ALICE}&limit=50`]);
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
