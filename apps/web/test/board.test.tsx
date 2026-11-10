import { ApiError } from "@tender/shared";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import Board from "../app/(app)/tasks/page";

// The board over a fake API: what it shows for each state of the request, how its segments narrow
// what it has, and how its tag and its paging ask the API. The filters are in the address, which
// the tests hold in a tiny model of the router: a replace changes the query and tells the page, as
// Next does.

const nav = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const model = {
    pathname: "/tasks",
    query: new URLSearchParams(),
    /** Every address the page replaced the history entry with, in order. */
    replaced: [] as string[],
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => model.query,
    /** The address changes by itself, as it does on Back and Forward. */
    go(search: string) {
      model.query = new URLSearchParams(search);
      for (const listener of listeners) listener();
    },
    replace(url: string) {
      model.replaced.push(url);
      model.go(url.includes("?") ? url.slice(url.indexOf("?")) : "");
    },
  };
  return model;
});
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => useSyncExternalStore(nav.subscribe, nav.snapshot, nav.snapshot),
}));

const TASK = {
  id: "7",
  title: "Extract invoice totals",
  category: "extraction",
  tags: ["extraction", "json"],
  token: "tusdc.tender-team.testnet",
  reward: "1500000",
  phase: "open",
  poster: "poster.tender-team.testnet",
  verifier: "judge.tender-team.testnet",
  created_at: "1793307169820229000",
  commit_deadline: "1793307289820229000",
  reveal_deadline: "1793307409820229000",
  pick_deadline: "1793307529820229000",
  fallback_deadline: "1793307649820229000",
  commit_count: 2,
  reveal_count: 0,
  working_count: 1,
  judge_status: null,
  judge_reason: null,
  is_team_poster: true,
  parent: null,
  outcome_kind: null,
};

const SECOND = 1_000_000_000n;
const CREATED = BigInt(TASK.created_at);

/**
 * Sets the time to `ns`, rounded up to a millisecond. With `ticks` the page's one-second timer is
 * fake too, and `settle` moves it.
 */
function pinClock(ns: bigint, { ticks = false } = {}) {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ticks ? ["Date", "setInterval", "clearInterval"] : ["Date"] });
  const ms = ns / 1_000_000n + (ns % 1_000_000n === 0n ? 0n : 1n);
  vi.setSystemTime(new Date(Number(ms)));
}

/** Lets the fake timers run for `ms`. */
const settle = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

const page = (...tasks: unknown[]) => ({ tasks, next_cursor: null });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/**
 * A `fetch` that gives the answers in turn, the last one for any call after them, and keeps the
 * address of each call.
 */
function fakeApi(...answers: Array<Response | Error>): { calls: () => number; urls: string[] } {
  let calls = 0;
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const answer = answers[Math.min(calls, answers.length - 1)];
    calls++;
    if (answer instanceof Error) throw answer;
    return answer?.clone();
  });
  return { calls: () => calls, urls };
}

/** The query of the `n`th request. */
const query = (api: { urls: string[] }, n: number) => new URL(api.urls[n] ?? "").searchParams;

/** `console.error` that prints nothing, for a test that reads what the board logs. */
const quietLog = () => vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  nav.query = new URLSearchParams();
  nav.replaced.length = 0;
  // The tasks of the tests are in their commit window, as the API listed them.
  pinClock(CREATED + 30n * SECOND);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("board_lists_the_tasks_the_api_sends", async () => {
  fakeApi(
    json(
      page(TASK, {
        ...TASK,
        id: "8",
        title: "Regex for valid NEAR account IDs",
        is_team_poster: false,
        poster: "alice.near",
      }),
    ),
  );

  render(<Board />);

  const cards = await screen.findAllByTestId("task-card");
  expect(cards).toHaveLength(2);
  const first = within(cards[0] as HTMLElement);
  expect(first.getByText("Extract invoice totals")).toBeTruthy();
  expect(first.getByTestId("amount").textContent).toBe("1.50 tUSDC");
  expect(first.getByTestId("phase-chip").textContent).toBe("Open");
  // The team's poster is labelled, anyone else's is not.
  expect(within(first.getByTestId("poster")).getByText("Run by Tender team")).toBeTruthy();
  const second = within(cards[1] as HTMLElement);
  expect(second.getByText("alice.near")).toBeTruthy();
  expect(second.queryByText("Run by Tender team")).toBeNull();
});

test("board_says_when_a_task_has_no_public_brief_yet", async () => {
  fakeApi(json(page({ ...TASK, title: null })));

  render(<Board />);

  const card = within(await screen.findByTestId("task-card"));
  expect(card.getByText(/no public brief yet/i)).toBeTruthy();
});

test("board_says_when_there_are_no_tasks", async () => {
  fakeApi(json(page()));

  render(<Board />);

  expect(await screen.findByText(/no tasks yet/i)).toBeTruthy();
  expect(screen.queryByTestId("task-card")).toBeNull();
});

test("board_shows_that_it_is_loading_until_the_api_answers", async () => {
  fakeApi(json(page(TASK)));

  render(<Board />);

  expect(screen.getByRole("status").textContent).toMatch(/loading/i);
  await screen.findByTestId("task-card");
  expect(screen.queryByRole("status")).toBeNull();
});

test("board_shows_an_error_state_that_retries_the_request", async () => {
  quietLog();
  const api = fakeApi(
    json({ error: "internal", message: "internal error" }, 500),
    json(page(TASK)),
  );
  render(<Board />);

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("500");
  expect(screen.queryByTestId("task-card")).toBeNull();

  await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));

  await screen.findByTestId("task-card");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(api.calls()).toBe(2);
});

test("board_shows_an_error_state_when_the_api_cannot_be_reached", async () => {
  quietLog();
  fakeApi(new TypeError("Failed to fetch"));

  render(<Board />);

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/can't reach/i);
});

test("board_logs_the_error_behind_the_words_it_shows", async () => {
  const log = quietLog();
  fakeApi(json({ error: "unavailable", message: "db down at 10.0.3.7" }, 503));

  render(<Board />);

  const alert = await screen.findByRole("alert");
  // The person is not given the server's words; the console gets the error itself.
  expect(alert.textContent).not.toContain("10.0.3.7");
  expect(log).toHaveBeenCalledTimes(1);
  const [logged] = log.mock.calls[0] ?? [];
  expect(logged).toBeInstanceOf(ApiError);
  expect(logged).toMatchObject({ status: 503, body: { message: "db down at 10.0.3.7" } });
});

test("board_logs_the_field_a_schema_refused_which_the_person_is_not_told", async () => {
  const log = quietLog();
  // A reward is a u128 as a decimal string: the API and this app have drifted apart.
  fakeApi(json(page({ ...TASK, reward: 1.5 })));

  render(<Board />);

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/can't read/i);
  expect(alert.textContent).not.toContain("reward");
  const [logged] = log.mock.calls[0] ?? [];
  expect((logged as Error).message).toContain("tasks.0.reward");
});

test("board_keeps_the_error_and_the_focused_button_while_it_retries", async () => {
  quietLog();
  const refusal = () => json({ error: "internal", message: "internal error" }, 500);
  const later: Array<(response: Response) => void> = [];
  let asked = 0;
  vi.stubGlobal("fetch", () => {
    asked++;
    // The first try fails at once. Each one after it answers when the test says so.
    return asked === 1
      ? Promise.resolve(refusal())
      : new Promise<Response>((resolve) => later.push(resolve));
  });
  render(<Board />);
  const alert = await screen.findByRole("alert");
  const retry = within(alert).getByRole("button", { name: "Retry" });
  retry.focus();

  await userEvent.keyboard("{Enter}");

  // Still the same alert and the same button, reading "Retrying…", and the button keeps the focus.
  expect(screen.getByRole("alert")).toBe(alert);
  expect(within(alert).getByRole("button", { name: "Retrying…" })).toBe(retry);
  expect(document.activeElement).toBe(retry);
  expect(screen.queryByRole("status")).toBeNull();
  // Another press while it is under way asks for nothing.
  await userEvent.keyboard("{Enter}");
  expect(asked).toBe(2);

  // The retry fails: the button is ready again, in the same place, still focused.
  later[0]?.(refusal());
  await waitFor(() => expect(retry.textContent).toBe("Retry"));
  expect(screen.getByRole("alert")).toBe(alert);
  expect(document.activeElement).toBe(retry);

  // One more try, and it works.
  await userEvent.keyboard("{Enter}");
  later[1]?.(json(page(TASK)));
  await screen.findByTestId("task-card");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(asked).toBe(3);
});

test("board_shows_the_newest_request_even_when_an_older_one_answers_last", async () => {
  const pending: Array<(response: Response) => void> = [];
  vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => pending.push(resolve)));

  // Strict mode runs the effect, undoes it and runs it again: two requests, the first one stale.
  render(
    <StrictMode>
      <Board />
    </StrictMode>,
  );
  await waitFor(() => expect(pending).toHaveLength(2));

  pending[1]?.(json(page({ ...TASK, title: "The newer answer" })));
  await screen.findByText("The newer answer");
  pending[0]?.(json(page({ ...TASK, title: "The older answer" })));
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(screen.queryByText("The older answer")).toBeNull();
  expect(screen.getByText("The newer answer")).toBeTruthy();
});

// ---- Cards ------------------------------------------------------------------------------------

test("board_links_each_card_to_its_task_page", async () => {
  fakeApi(json(page(TASK, { ...TASK, id: "8", title: null })));

  render(<Board />);

  const cards = await screen.findAllByTestId("task-card");
  // The card's one link is its round arrow, named for the task, and it stretches over the card.
  const titled = within(cards[0] as HTMLElement).getByRole("link", {
    name: "Open task: Extract invoice totals",
  });
  expect(titled.getAttribute("href")).toBe("/tasks/7");
  expect(titled.className).toContain("after:inset-0");
  expect(within(cards[0] as HTMLElement).getByRole("heading", { level: 2 }).textContent).toBe(
    "Extract invoice totals",
  );
  // A task with no public brief has a page too: its title is the stand-in.
  const untitled = within(cards[1] as HTMLElement).getByRole("link", {
    name: /^Open task: .*no public brief yet/i,
  });
  expect(untitled.getAttribute("href")).toBe("/tasks/8");
});

test("board_flags_what_a_reader_must_know_of_the_judge_and_nothing_when_it_accepted", async () => {
  fakeApi(
    json(
      page(
        {
          ...TASK,
          id: "1",
          judge_status: "accepted",
          judge_reason: "not judged: needs a held-out part",
        },
        { ...TASK, id: "2", judge_status: "pending", judge_reason: "waiting for held-out checks" },
        { ...TASK, id: "3", judge_status: "accepted", judge_reason: null },
        { ...TASK, id: "4", judge_status: null, judge_reason: null },
        { ...TASK, id: "5", judge_status: "rejected", judge_reason: "the rule does not compile" },
        { ...TASK, id: "6", judge_status: "failed_closed", judge_reason: null },
        { ...TASK, id: "7", judge_status: null, judge_reason: "waiting for the Judge" },
      ),
    ),
  );

  render(<Board />);

  const chips = (await screen.findAllByTestId("task-card")).map((card) => {
    const chip = within(card).queryByTestId("judge-chip");
    return chip === null ? null : [chip.querySelector(".truncate")?.textContent, chip.title];
  });
  // Plain words on the card; the Judge's own, reason included, in the chip's tooltip. An accepted
  // task with nothing more to say, and one the Judge has not looked at, have no chip.
  expect(chips).toEqual([
    ["Judge couldn't score this task", "Judge: accepted · not judged: needs a held-out part"],
    ["Judge hasn't checked this yet", "Judge: not decided yet · waiting for held-out checks"],
    null,
    null,
    ["Judge refused this task", "Judge: turned this task down · the rule does not compile"],
    ["Judge couldn't check this task", "Judge: could not check this task"],
    ["Judge left a note", "Judge: waiting for the Judge"],
  ]);
  // No "Judge: accepted" line on a card.
  expect(screen.queryByTestId("judge-note")).toBeNull();
  // A screen reader hears the Judge's words after the chip's.
  const first = screen.getAllByTestId("judge-chip")[0] as HTMLElement;
  expect(first.querySelector(".sr-only")?.textContent).toBe(
    " (Judge: accepted · not judged: needs a held-out part)",
  );
});

test("board_shows_the_judges_words_as_text_never_as_html", async () => {
  fakeApi(json(page({ ...TASK, judge_reason: '<img src=x onerror="alert(1)">' })));

  render(<Board />);

  await screen.findByTestId("task-card");
  expect(document.querySelector("img")).toBeNull();
  const chip = screen.getByTestId("judge-chip");
  expect(chip.title).toContain('<img src=x onerror="alert(1)">');
  expect(chip.textContent).toContain('<img src=x onerror="alert(1)">');
});

// ---- Filters ----------------------------------------------------------------------------------

/** A settled task beside the open one: the segments have something to tell apart. */
const SETTLED = {
  ...TASK,
  id: "9",
  title: "A settled task",
  phase: "settled",
  outcome_kind: "picked",
};

/** Each segment of the control, by its words (the label and the count) and whether it is pressed. */
const pressed = () =>
  within(screen.getByRole("group", { name: "Phase" }))
    .getAllByRole("button")
    .map((chip) => `${chip.textContent}:${chip.getAttribute("aria-pressed")}`);

test("board_segments_narrow_the_tasks_it_has_by_the_clock_and_count_them", async () => {
  const api = fakeApi(json(page(TASK, SETTLED)));
  render(<Board />);
  await screen.findAllByTestId("task-card");
  // All the tasks to begin with, read a page of 50 at a time with no phase asked for: the segments
  // narrow what the board has, by the phase each card shows, and ask the API for nothing.
  expect(query(api, 0).has("phase")).toBe(false);
  expect(query(api, 0).get("limit")).toBe("50");
  expect(pressed()).toEqual(["All 2:true", "Open 1:false", "Judging 0:false", "Settled 1:false"]);

  await userEvent.click(screen.getByRole("button", { name: /^Settled/ }));

  expect(pressed()).toEqual(["All 2:false", "Open 1:false", "Judging 0:false", "Settled 1:true"]);
  expect(screen.getAllByTestId("task-card").map((card) => card.textContent)).toEqual([
    expect.stringContaining("A settled task"),
  ]);
  expect(api.urls).toHaveLength(1);

  await userEvent.click(screen.getByRole("button", { name: /^All/ }));

  expect(screen.getAllByTestId("task-card")).toHaveLength(2);
  expect(api.urls).toHaveLength(1);
});

test("board_judging_segment_holds_the_tasks_being_revealed_and_judged", async () => {
  // Past the commit deadline TASK is in its reveal window; one more task is past its reveal one.
  pinClock(BigInt(TASK.commit_deadline) + 5n * SECOND);
  const judging = {
    ...TASK,
    id: "10",
    title: "A task being judged",
    created_at: (CREATED - 200n * SECOND).toString(),
    commit_deadline: (CREATED - 100n * SECOND).toString(),
    reveal_deadline: (CREATED + 10n * SECOND).toString(),
  };
  fakeApi(json(page(TASK, judging, SETTLED)));
  render(<Board />);
  await screen.findAllByTestId("task-card");
  expect(pressed()).toEqual(["All 3:true", "Open 0:false", "Judging 2:false", "Settled 1:false"]);

  await userEvent.click(screen.getByRole("button", { name: /^Judging/ }));

  const phases = screen
    .getAllByTestId("task-card")
    .map((card) => within(card).getByTestId("phase-chip").textContent);
  expect(phases).toEqual(["Revealing", "Judging"]);
  expect(nav.replaced).toEqual(["/tasks?phase=judging"]);
});

test("board_summary_says_how_many_are_open_and_what_they_lock", async () => {
  fakeApi(
    json(
      page(
        TASK,
        { ...TASK, id: "8", reward: "2500000" },
        // Settled: not open, and its reward is paid out.
        SETTLED,
        // A token the app has no decimals for: counted as open, its amount left out of the line.
        { ...TASK, id: "11", reward: "42", token: "odd.testnet" },
      ),
    ),
  );
  render(<Board />);
  await screen.findAllByTestId("task-card");
  expect(screen.getByTestId("board-summary").textContent).toBe("3 open · 4.00 tUSDC locked");
});

test("board_summary_says_it_counts_only_what_it_loaded_when_there_is_more", async () => {
  fakeApi(json({ tasks: [TASK], next_cursor: "7" }));
  render(<Board />);
  await screen.findByTestId("task-card");
  expect(screen.getByTestId("board-summary").textContent).toBe(
    "1 open · 1.50 tUSDC locked · of the 1 tasks loaded",
  );
});

test("board_asks_the_api_for_the_tag_the_address_holds_and_clear_takes_it_off", async () => {
  nav.go("?tag=json");
  const api = fakeApi(json(page(TASK)));
  render(<Board />);
  await screen.findByTestId("task-card");
  expect(query(api, 0).get("tag")).toBe("json");

  await userEvent.click(screen.getByRole("button", { name: "Clear" }));

  await waitFor(() => expect(api.urls).toHaveLength(2));
  expect(query(api, 1).has("tag")).toBe(false);
  expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  expect(nav.replaced).toEqual(["/tasks"]);
});

test("board_keeps_the_phase_when_the_tag_changes_and_the_tag_when_the_phase_does", async () => {
  nav.go("?phase=open&tag=json");
  const api = fakeApi(json(page(TASK)));
  render(<Board />);
  await screen.findByTestId("task-card");

  await userEvent.click(screen.getByRole("button", { name: /^Settled/ }));
  expect(nav.replaced.at(-1)).toBe("/tasks?phase=settled&tag=json");
  // A segment asks for nothing: the tag is the board's one question to the API.
  expect(api.urls).toHaveLength(1);

  await userEvent.click(screen.getByRole("button", { name: "Clear" }));

  await waitFor(() => expect(api.urls).toHaveLength(2));
  expect(query(api, 1).has("tag")).toBe(false);
  expect(nav.replaced.at(-1)).toBe("/tasks?phase=settled");
});

test("board_has_no_tag_field_and_no_filter_button", async () => {
  // Tender asks for no category: the board narrows by phase only, and a tag only by its address.
  fakeApi(json(page(TASK)));
  render(<Board />);
  await screen.findByTestId("task-card");
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByLabelText("Tag")).toBeNull();
  expect(screen.queryByRole("button", { name: "Filter" })).toBeNull();
});

test("board_shows_the_tags_of_a_card_as_text_and_not_as_buttons", async () => {
  fakeApi(json(page({ ...TASK, tags: ["extraction", "json", "invoices"] })));
  render(<Board />);
  const card = within(await screen.findByTestId("task-card"));

  expect(card.getByText("json")).toBeTruthy();
  expect(card.queryByRole("button")).toBeNull();
  // Two tags at most on a card: its page has them all.
  expect(card.queryByText("invoices")).toBeNull();
});

test("board_says_when_no_task_matches_the_filters", async () => {
  fakeApi(json(page(TASK)));
  render(<Board />);
  await screen.findByTestId("task-card");

  await userEvent.click(screen.getByRole("button", { name: /^Settled/ }));

  expect(await screen.findByText(/no tasks match/i)).toBeTruthy();
  expect(screen.queryByText(/no tasks yet/i)).toBeNull();
  expect(screen.getByRole("link", { name: "Show all tasks" }).getAttribute("href")).toBe("/tasks");
});

test("board_drops_the_answer_to_a_filter_that_is_no_longer_the_one_asked_for", async () => {
  const pending: Array<(response: Response) => void> = [];
  vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => pending.push(resolve)));
  render(<Board />);
  await waitFor(() => expect(pending).toHaveLength(1));

  // A tag in the address while the first read is still out: the board asks again.
  act(() => nav.go("?tag=json"));
  await waitFor(() => expect(pending).toHaveLength(2));
  pending[1]?.(json(page({ ...TASK, title: "Answer for json" })));
  await screen.findByText("Answer for json");
  pending[0]?.(json(page({ ...TASK, title: "Answer for All" })));
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(screen.queryByText("Answer for All")).toBeNull();
  expect(screen.getByText("Answer for json")).toBeTruthy();
});

// ---- The filters are in the address ------------------------------------------------------------

test("board_puts_each_filter_in_the_address_and_replaces_the_entry_it_is_on", async () => {
  nav.go("?tag=json");
  const api = fakeApi(json(page(TASK)));
  render(<Board />);
  await screen.findByTestId("task-card");

  await userEvent.click(screen.getByRole("button", { name: /^Open/ }));
  await userEvent.click(screen.getByRole("button", { name: /^All/ }));
  await userEvent.click(screen.getByRole("button", { name: "Clear" }));
  await waitFor(() => expect(api.urls).toHaveLength(2));

  // A filter changes the address of the board and adds nothing to the history, and the board is
  // addressed where it is (`/tasks` here), whatever that is.
  expect(nav.replaced).toEqual(["/tasks?phase=open&tag=json", "/tasks?tag=json", "/tasks"]);
});

test("board_opens_on_the_filters_the_address_holds", async () => {
  nav.go("?phase=judging&tag=json");
  const api = fakeApi(json(page(TASK)));

  render(<Board />);

  await screen.findByText(/no tasks match/i);
  expect(query(api, 0).get("tag")).toBe("json");
  expect(query(api, 0).has("phase")).toBe(false);
  expect(api.urls).toHaveLength(1);
  expect(screen.getByRole("button", { name: /^Judging/ }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
});

test("board_opens_an_older_link_to_revealing_on_the_judging_segment", async () => {
  nav.go("?phase=revealing");
  fakeApi(json(page(TASK)));
  render(<Board />);
  await screen.findByText(/no tasks match/i);
  expect(screen.getByRole("button", { name: /^Judging/ }).getAttribute("aria-pressed")).toBe(
    "true",
  );
});

test("board_follows_the_address_when_it_changes_under_it_as_on_back", async () => {
  nav.go("?phase=open&tag=json");
  const api = fakeApi(json(page(TASK)));
  render(<Board />);
  await screen.findByTestId("task-card");

  // Back to an address with other filters, and then to one with none.
  act(() => nav.go("?phase=settled"));
  await waitFor(() => expect(api.urls).toHaveLength(2));
  expect(query(api, 1).has("tag")).toBe(false);
  expect(screen.getByRole("button", { name: /^Settled/ }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();

  act(() => nav.go(""));
  // The same tag (none): the board has its tasks, and only the segment changes.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^All/ }).getAttribute("aria-pressed")).toBe("true"),
  );
  expect(api.urls).toHaveLength(2);
});

test.each([
  ["a_phase_with_no_chip", "?phase=fallback"],
  ["a_phase_that_is_no_phase", "?phase=bogus"],
  ["a_tag_the_api_would_refuse", "?tag=not%20a%20tag!"],
  ["a_tag_that_is_too_long", `?tag=${"a".repeat(25)}`],
])("board_ignores_%s_in_the_address", async (_name, search) => {
  nav.go(search);
  const api = fakeApi(json(page(TASK)));

  render(<Board />);

  await screen.findByTestId("task-card");
  expect(query(api, 0).has("phase")).toBe(false);
  expect(query(api, 0).has("tag")).toBe(false);
  expect(screen.getByRole("button", { name: /^All/ }).getAttribute("aria-pressed")).toBe("true");
});

test("board_reads_a_tag_of_the_address_as_a_person_would_type_it", async () => {
  nav.go("?tag=%20JSON%20");
  const api = fakeApi(json(page(TASK)));

  render(<Board />);

  await screen.findByTestId("task-card");
  expect(query(api, 0).get("tag")).toBe("json");
});

// ---- A card and its page say the same phase -----------------------------------------------------

test("board_cards_show_the_phase_by_the_clock_and_not_the_one_the_api_gave_when_it_answered", async () => {
  // The API said Open when it answered; the time is now past the commit deadline.
  pinClock(BigInt(TASK.commit_deadline) + 5n * SECOND);
  fakeApi(json(page(TASK)));

  render(<Board />);

  const card = within(await screen.findByTestId("task-card"));
  expect(card.getByTestId("phase-chip").textContent).toBe("Revealing");
});

test("board_cards_move_on_to_the_next_phase_at_its_deadline_without_a_reload", async () => {
  pinClock(BigInt(TASK.commit_deadline) - 2n * SECOND, { ticks: true });
  const api = fakeApi(json(page(TASK)));
  render(<Board />);
  const card = within(await screen.findByTestId("task-card"));
  expect(card.getByTestId("phase-chip").textContent).toBe("Open");

  await settle(3000);

  expect(card.getByTestId("phase-chip").textContent).toBe("Revealing");
  expect(api.calls()).toBe(1);
});

test("board_cards_show_settled_for_a_task_with_an_outcome_whatever_the_clock_says", async () => {
  fakeApi(json(page({ ...TASK, phase: "settled", outcome_kind: "picked" })));

  render(<Board />);

  const card = within(await screen.findByTestId("task-card"));
  expect(card.getByTestId("phase-chip").textContent).toBe("Settled");
});

// ---- Cards: who picks ---------------------------------------------------------------------------

test("board_flags_a_task_whose_poster_is_also_its_verifier", async () => {
  fakeApi(json(page({ ...TASK, id: "1", verifier: TASK.poster }, { ...TASK, id: "2" })));

  render(<Board />);

  const [poster, other] = await screen.findAllByTestId("task-card");
  expect(within(poster as HTMLElement).getByTestId("poster-judges").textContent).toBe(
    "Poster judges their own task",
  );
  expect(within(other as HTMLElement).queryByTestId("poster-judges")).toBeNull();
});

test("board_shows_a_task_with_a_repeated_tag_once_for_each_time_without_a_key_clash", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  fakeApi(json(page({ ...TASK, tags: ["json", "json", "extraction"] })));

  render(<Board />);

  const card = within(await screen.findByTestId("task-card"));
  expect(card.getAllByText("json")).toHaveLength(2);
  // React says it with console.error when two children have the same key.
  expect(log.mock.calls.flat().join("\n")).not.toContain("same key");
});

// ---- More pages -------------------------------------------------------------------------------

test("board_loads_the_next_page_with_the_cursor_the_api_gave", async () => {
  const api = fakeApi(
    json({ tasks: [TASK], next_cursor: "7" }),
    json({ tasks: [{ ...TASK, id: "6", title: "An older task" }], next_cursor: null }),
  );
  render(<Board />);
  await screen.findByTestId("task-card");
  expect(query(api, 0).has("cursor")).toBe(false);

  await userEvent.click(screen.getByRole("button", { name: "Load more" }));

  await screen.findByText("An older task");
  expect(query(api, 1).get("cursor")).toBe("7");
  expect(screen.getAllByTestId("task-card")).toHaveLength(2);
  // That was the last page: a line stands where the button was.
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  expect(screen.getByText("No more tasks")).toBeTruthy();
});

test("board_has_no_load_more_on_the_last_page", async () => {
  fakeApi(json(page(TASK)));
  render(<Board />);

  await screen.findByTestId("task-card");

  // Nothing was read on from, so there is nothing to say the end of.
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  expect(screen.queryByText("No more tasks")).toBeNull();
});

test("board_keeps_its_tasks_when_the_next_page_fails_and_offers_a_retry", async () => {
  quietLog();
  const api = fakeApi(
    json({ tasks: [TASK], next_cursor: "7" }),
    json({ error: "internal", message: "internal error" }, 500),
    json({ tasks: [{ ...TASK, id: "6", title: "An older task" }], next_cursor: null }),
  );
  render(<Board />);
  await screen.findByTestId("task-card");

  await userEvent.click(screen.getByRole("button", { name: "Load more" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("500");
  expect(screen.getAllByTestId("task-card")).toHaveLength(1);

  await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));

  await screen.findByText("An older task");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(query(api, 2).get("cursor")).toBe("7");
  // The retry button had the focus, and is gone with the last page.
  expect(document.activeElement).toBe(screen.getByText("No more tasks"));
});

test("board_moves_the_focus_to_the_line_that_replaces_load_more", async () => {
  fakeApi(
    json({ tasks: [TASK], next_cursor: "7" }),
    json({ tasks: [{ ...TASK, id: "6", title: "An older task" }], next_cursor: null }),
  );
  render(<Board />);
  await screen.findByTestId("task-card");

  await userEvent.click(screen.getByRole("button", { name: "Load more" }));

  const line = await screen.findByText("No more tasks");
  // A button taken off the page drops the focus to the top of the document: the line takes it.
  expect(document.activeElement).toBe(line);
});

test("board_leaves_the_focus_where_the_person_went_while_the_last_page_loaded", async () => {
  const pending: Array<(response: Response) => void> = [];
  const answers = [json({ tasks: [TASK], next_cursor: "7" })];
  vi.stubGlobal(
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        const first = answers.shift();
        if (first) resolve(first);
        else pending.push(resolve);
      }),
  );
  render(<Board />);
  await screen.findByTestId("task-card");
  await userEvent.click(screen.getByRole("button", { name: "Load more" }));
  await waitFor(() => expect(pending).toHaveLength(1));
  // While the page is on its way the person goes on to a segment of the control.
  const open = screen.getByRole("button", { name: /^Open/ });
  await userEvent.click(open);

  pending[0]?.(json({ tasks: [{ ...TASK, id: "6", title: "An older task" }], next_cursor: null }));

  await screen.findByText("No more tasks");
  expect(document.activeElement).toBe(open);
});

// ---- The featured card ------------------------------------------------------------------------

test("board_features_the_open_task_with_the_top_reward_and_keeps_the_api_order", async () => {
  fakeApi(
    json(
      page(
        { ...TASK, id: "1", reward: "500000" },
        { ...TASK, id: "2", reward: "2500000" },
        // Larger, but not open any more: settled.
        { ...TASK, id: "3", reward: "9000000", phase: "settled", outcome_kind: "picked" },
      ),
    ),
  );

  render(<Board />);

  const cards = await screen.findAllByTestId("task-card");
  // The order is the API's: featuring a card does not move it.
  expect(cards.map((card) => within(card).getByRole("link").getAttribute("href"))).toEqual([
    "/tasks/1",
    "/tasks/2",
    "/tasks/3",
  ]);
  expect(cards.map((card) => card.getAttribute("data-featured"))).toEqual([
    "false",
    "true",
    "false",
  ]);
  expect(within(cards[1] as HTMLElement).getByText("Top reward")).toBeTruthy();
  expect(within(cards[0] as HTMLElement).queryByText("Top reward")).toBeNull();
});

test("board_features_no_card_when_only_one_task_is_open", async () => {
  fakeApi(json(page(TASK, SETTLED)));
  render(<Board />);
  const cards = await screen.findAllByTestId("task-card");
  expect(cards.map((card) => card.getAttribute("data-featured"))).toEqual(["false", "false"]);
  expect(screen.queryByText("Top reward")).toBeNull();
});
