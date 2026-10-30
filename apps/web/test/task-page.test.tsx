import { ApiError, type TaskOutcome } from "@tender/shared";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TaskView } from "../components/TaskView";
import { committedData, FakeEventSource, message } from "./fakeEventSource";
import {
  AT,
  agent,
  detail,
  entry,
  HASH_A,
  HASH_B,
  HASH_C,
  POSTER,
  revealed,
  SECOND,
  scorecard,
  VERIFIER,
} from "./tasks";

// The task page over a fake API and a fake event stream, with the clock pinned: the fixtures'
// windows are in the past by now, so the page's phase is whatever a test sets the time to.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const agentDetail = (overrides = {}) => ({ agent: agent(overrides), recent_entries: [] });
const TASK_PATH = "/v1/tasks/7";
const AGENT_PATH = `/v1/agents/${VERIFIER}`;

type Handler = () => Response | Promise<Response>;

/** A `fetch` that answers by path, a 404 in the API's own words for a path nobody handles. */
function fakeApi(handlers: Record<string, Handler>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    const handler = handlers[path];
    return handler ? handler() : json({ error: "not_found", message: "no such route" }, 404);
  });
  return {
    calls,
    count: (path: string) => calls.filter((called) => called === path).length,
  };
}

/** The routes of a task page: the task, and its verifier's agent profile. */
const routes = (
  body: () => unknown = () => detail(),
  verifier: Handler = () => json(agentDetail()),
) => ({
  [TASK_PATH]: () => json(body()),
  [AGENT_PATH]: verifier,
});

/**
 * Sets the time to `ns`, rounded up to a millisecond so that a page never reads it as before the
 * moment it was given. With `ticks` the page's one-second timer is fake too, and `settle` moves it.
 */
function pinClock(ns: bigint, { ticks = false } = {}) {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ticks ? ["Date", "setInterval", "clearInterval"] : ["Date"] });
  const ms = ns / 1_000_000n + (ns % 1_000_000n === 0n ? 0n : 1n);
  vi.setSystemTime(new Date(Number(ms)));
}

/** Lets the fake timers run for `ms`. */
const settle = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

const quietLog = () => vi.spyOn(console, "error").mockImplementation(() => {});

/** The page, loaded. */
async function open(id = "7") {
  const view = render(<TaskView id={id} />);
  await screen.findByRole("heading", { level: 1 });
  return view;
}

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  pinClock(AT.created + 30n * SECOND);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- Loading ----------------------------------------------------------------------------------

test("task_page_shows_the_task_with_all_its_parts", async () => {
  fakeApi(routes());
  render(<TaskView id="7" />);

  expect(screen.getByRole("status").textContent).toMatch(/loading/i);
  const title = await screen.findByRole("heading", { level: 1 });

  expect(title.textContent).toBe("Extract invoice totals");
  expect(screen.getByTestId("phase-chip").textContent).toBe("Open");
  expect(within(screen.getByTestId("poster")).getByText(POSTER)).toBeTruthy();
  expect(within(screen.getByTestId("poster")).getByText("Run by Tender team")).toBeTruthy();
  expect(screen.getByTestId("phase-timeline")).toBeTruthy();
  expect(screen.getByTestId("brief-instructions")).toBeTruthy();
  expect(screen.getByTestId("criteria-kind").textContent).toBe("regex_cases");
  expect(screen.getByTestId("entry-summary").textContent).toBe("2 committed · 0 revealed");
  expect(screen.getByTestId("verifier-record")).toBeTruthy();
  const funders = screen.getAllByTestId("funder-row");
  expect(funders).toHaveLength(1);
  expect(funders[0]?.textContent).toContain(POSTER);
  expect(within(funders[0] as HTMLElement).getByTestId("amount").textContent).toBe("1.50 tUSDC");
  // Nothing has been picked.
  expect(screen.queryByTestId("scorecard")).toBeNull();
  expect(screen.queryByTestId("payouts")).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
});

test("task_page_asks_for_the_task_and_then_for_its_verifier", async () => {
  const api = fakeApi(routes());

  await open();

  // The verifier is the task's, from the answer: what the address held is not used for it.
  expect(api.calls).toEqual([TASK_PATH, AGENT_PATH]);
});

test("task_page_says_when_there_is_no_such_task", async () => {
  fakeApi({ [TASK_PATH]: () => json({ error: "not_found", message: "no such task" }, 404) });
  render(<TaskView id="7" />);

  expect(await screen.findByText(/no task with this id/i)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByTestId("phase-timeline")).toBeNull();
});

test("task_page_asks_nothing_for_an_address_that_is_no_task_id", async () => {
  const api = fakeApi(routes());
  render(<TaskView id="seven" />);

  expect(await screen.findByText(/no task with this id/i)).toBeTruthy();
  expect(api.calls).toEqual([]);
});

test("task_page_shows_an_error_state_that_retries_and_logs_the_error", async () => {
  const log = quietLog();
  let failing = true;
  const api = fakeApi({
    [TASK_PATH]: () =>
      failing ? json({ error: "internal", message: "db down at 10.0.3.7" }, 500) : json(detail()),
    [AGENT_PATH]: () => json(agentDetail()),
  });
  render(<TaskView id="7" />);

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("500");
  expect(alert.textContent).not.toContain("10.0.3.7");
  const [logged] = log.mock.calls[0] ?? [];
  expect(logged).toBeInstanceOf(ApiError);
  expect(screen.queryByTestId("phase-timeline")).toBeNull();

  failing = false;
  await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));

  await screen.findByRole("heading", { level: 1 });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(api.count(TASK_PATH)).toBe(2);
});

test("task_page_shows_an_error_state_when_the_verifier_cannot_be_read", async () => {
  quietLog();
  fakeApi(
    routes(
      () => detail(),
      () => json({ error: "internal", message: "x" }, 500),
    ),
  );
  render(<TaskView id="7" />);

  // A page that cannot say who judges the task does not pretend to be whole.
  expect((await screen.findByRole("alert")).textContent).toContain("500");
});

// ---- What it shows ----------------------------------------------------------------------------

test("task_page_shows_the_judges_reason_whenever_there_is_one", async () => {
  fakeApi(
    routes(() =>
      detail({ judge_status: "accepted", judge_reason: "not judged: needs a held-out part" }),
    ),
  );

  await open();

  expect(screen.getByTestId("judge-note").textContent).toBe(
    "Judge: accepted · not judged: needs a held-out part",
  );
});

test("task_page_lists_the_funders_the_subtasks_and_the_parent_as_links", async () => {
  fakeApi(
    routes(() =>
      detail(
        { parent: "3" },
        {
          funders: [
            { account: POSTER, amount: "1000000" },
            { account: "dave.testnet", amount: "500000" },
          ],
          children: ["9", "12"],
        },
      ),
    ),
  );

  await open();

  const funders = screen.getAllByTestId("funder-row");
  expect(funders.map((row) => row.textContent)).toEqual([
    `${POSTER}1.00 tUSDC`,
    "dave.testnet0.50 tUSDC",
  ]);
  const children = screen.getAllByTestId("child-link") as HTMLAnchorElement[];
  expect(children.map((link) => link.getAttribute("href"))).toEqual(["/tasks/9", "/tasks/12"]);
  expect(children.map((link) => link.textContent)).toEqual(["Task #9", "Task #12"]);
  const parent = screen.getByTestId("parent-link");
  expect(parent.getAttribute("href")).toBe("/tasks/3");
});

test("task_page_has_no_funders_or_subtasks_section_when_there_are_none", async () => {
  fakeApi(routes(() => detail({}, { funders: [], children: [] })));

  await open();

  expect(screen.queryByTestId("funder-row")).toBeNull();
  expect(screen.queryByTestId("child-link")).toBeNull();
  expect(screen.queryByTestId("parent-link")).toBeNull();
});

test("task_page_shows_the_verifiers_record", async () => {
  fakeApi(
    routes(
      () => detail(),
      () => json(agentDetail({ picks_made: 12, voids_after_reveals: 1 })),
    ),
  );

  await open();

  const record = within(screen.getByTestId("verifier-record"));
  expect(record.getByText(VERIFIER)).toBeTruthy();
  expect(record.getByTestId("picks-made").textContent).toBe("12");
  expect(record.getByTestId("voids-after-reveals").textContent).toBe("1");
  expect(record.getByText("Run by Tender team")).toBeTruthy();
  expect(record.queryByText("Poster judges their own task")).toBeNull();
});

test("task_page_flags_a_poster_who_judges_their_own_task", async () => {
  // The poster is the verifier, and has never registered as an agent.
  fakeApi(
    routes(
      () => detail({ poster: VERIFIER }),
      () => json({ error: "not_found", message: "no such agent" }, 404),
    ),
  );

  await open();

  const record = within(screen.getByTestId("verifier-record"));
  expect(record.getByText("Poster judges their own task")).toBeTruthy();
  expect(record.getByText(/no record/i)).toBeTruthy();
});

test("task_page_shows_the_title_of_a_task_with_no_public_brief", async () => {
  fakeApi(routes(() => detail({ title: null }, { brief: null, criteria: null })));

  await open();

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "Untitled task (no public brief yet)",
  );
  expect(screen.getByText(/brief is not available/i)).toBeTruthy();
  expect(screen.getByText(/public criteria are not available/i)).toBeTruthy();
});

// ---- The clock --------------------------------------------------------------------------------

test("task_page_follows_the_clock_into_the_next_phase", async () => {
  pinClock(AT.commit - 3n * SECOND, { ticks: true });
  fakeApi(routes());
  await open();
  expect(screen.getByTestId("phase-chip").textContent).toBe("Open");
  expect(screen.getByTestId("live-status").textContent).toBe("Commit window closes in 3s");

  await settle(1000);
  expect(screen.getByTestId("live-status").textContent).toBe("Commit window closes in 2s");

  // The windows are half-open: at the deadline the next one has begun. Nothing was fetched.
  await settle(2000);
  expect(screen.getByTestId("phase-chip").textContent).toBe("Revealing");
  expect(screen.getByTestId("live-status").textContent).toBe("Reveal window closes in 5m 0s");
});

test("task_page_shows_a_hash_in_the_reveal_window_and_the_link_when_it_ends", async () => {
  pinClock(AT.reveal - 2n * SECOND, { ticks: true });
  fakeApi(routes(() => detail({}, { entries: [revealed("alice.testnet", HASH_A)] })));
  await open();
  // The API served this as an open task, and the clock says it is revealing: the page goes by the
  // clock, which is also what the API's gate on content goes by.
  expect(screen.getByTestId("phase-chip").textContent).toBe("Revealing");
  expect(screen.getByText(`Revealed · sha256 ${HASH_A}`)).toBeTruthy();
  expect(screen.queryByRole("link", { name: /open content/i })).toBeNull();

  await settle(2000);

  expect(screen.getByTestId("phase-chip").textContent).toBe("Judging");
  expect(screen.getByRole("link", { name: /open content/i }).getAttribute("href")).toBe(
    `http://api.test/v1/blobs/${HASH_A}`,
  );
});

// ---- Live updates -----------------------------------------------------------------------------

test("task_page_asks_again_when_an_event_for_this_task_arrives", async () => {
  let current = detail();
  const api = fakeApi(routes(() => current));
  await open();
  expect(api.count(TASK_PATH)).toBe(1);
  const stream = FakeEventSource.latest;
  expect(stream.url).toBe("http://api.test/v1/events");

  // The stream opens with no id to resume from, so the page asks once more in case it missed
  // something between its first answer and that moment.
  act(() => stream.open());
  await waitFor(() => expect(api.count(TASK_PATH)).toBe(2));

  current = detail(
    {},
    {
      entries: [
        entry("alice.testnet"),
        entry("bob.testnet", { entry_index: 1 }),
        entry("carol.testnet", { entry_index: 2 }),
      ],
    },
  );
  act(() =>
    stream.send("committed", message("committed", "7", committedData("7", "carol.testnet")), "11"),
  );

  await waitFor(() =>
    expect(screen.getByTestId("entry-summary").textContent).toBe("3 committed · 0 revealed"),
  );
  expect(api.count(TASK_PATH)).toBe(3);
  // No reload: the page is the same one, and the verifier is asked for again with the task.
  expect(api.count(AGENT_PATH)).toBe(3);
});

test("task_page_ignores_events_about_other_tasks", async () => {
  const api = fakeApi(routes());
  await open();
  const stream = FakeEventSource.latest;
  act(() => stream.open());
  await waitFor(() => expect(api.count(TASK_PATH)).toBe(2));

  act(() => stream.send("committed", message("committed", "8", committedData("8")), "12"));
  // An event with no task at all, such as an agent registering.
  act(() => stream.send("committed", message("committed", null, committedData("7")), "13"));
  await new Promise((resolve) => setTimeout(resolve, 30));

  expect(api.count(TASK_PATH)).toBe(2);
});

test("task_page_shows_a_reveal_without_a_reload", async () => {
  let current = detail({}, { entries: [entry("alice.testnet")] });
  fakeApi(routes(() => current));
  pinClock(AT.commit + 30n * SECOND);
  await open();
  expect(screen.getByText(/^Sealed entry · committed at block 123456$/)).toBeTruthy();
  const stream = FakeEventSource.latest;
  act(() => stream.open());

  current = detail({}, { entries: [revealed("alice.testnet", HASH_A)] });
  act(() =>
    stream.send(
      "revealed",
      message("revealed", "7", {
        task_id: "7",
        account: "alice.testnet",
        content_hash: HASH_A,
        uri: `http://api.test/v1/blobs/${HASH_A}`,
      }),
      "12",
    ),
  );

  expect(await screen.findByText(`Revealed · sha256 ${HASH_A}`)).toBeTruthy();
  expect(screen.queryByText(/^Sealed entry/)).toBeNull();
  expect(screen.getByTestId("entry-summary").textContent).toBe("1 committed · 1 revealed");
});

test("task_page_keeps_what_it_shows_when_asking_again_fails", async () => {
  const log = quietLog();
  let failing = false;
  const api = fakeApi({
    [TASK_PATH]: () => (failing ? json({ error: "internal", message: "x" }, 500) : json(detail())),
    [AGENT_PATH]: () => json(agentDetail()),
  });
  await open();
  const stream = FakeEventSource.latest;
  act(() => stream.open());
  await waitFor(() => expect(api.count(TASK_PATH)).toBe(2));

  failing = true;
  act(() => stream.send("committed", message("committed", "7", committedData("7")), "11"));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/out of date/i);
  expect(alert.textContent).toContain("500");
  // What was there stays there.
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Extract invoice totals");
  expect(screen.getByTestId("entry-summary")).toBeTruthy();
  expect(log).toHaveBeenCalled();

  failing = false;
  await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));

  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
});

test("task_page_shows_the_newest_answer_even_when_an_older_one_arrives_last", async () => {
  const later: Array<(response: Response) => void> = [];
  let first = true;
  const api = fakeApi({
    [TASK_PATH]: () => {
      if (first) {
        first = false;
        return json(detail());
      }
      return new Promise<Response>((resolve) => later.push(resolve));
    },
    [AGENT_PATH]: () => json(agentDetail()),
  });
  await open();
  const stream = FakeEventSource.latest;
  act(() => stream.send("committed", message("committed", "7", committedData("7")), "11"));
  act(() => stream.send("committed", message("committed", "7", committedData("7")), "12"));
  await waitFor(() => expect(later).toHaveLength(2));

  await act(async () => {
    later[1]?.(
      json(
        detail(
          {},
          {
            entries: [
              entry("a.testnet"),
              entry("b.testnet", { entry_index: 1 }),
              entry("c.testnet", { entry_index: 2 }),
            ],
          },
        ),
      ),
    );
  });
  await waitFor(() =>
    expect(screen.getByTestId("entry-summary").textContent).toBe("3 committed · 0 revealed"),
  );
  await act(async () => {
    later[0]?.(json(detail({}, { entries: [entry("a.testnet")] })));
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(screen.getByTestId("entry-summary").textContent).toBe("3 committed · 0 revealed");
  expect(api.count(TASK_PATH)).toBe(3);
});

test("task_page_closes_the_stream_when_it_goes", async () => {
  fakeApi(routes());
  const view = await open();
  const stream = FakeEventSource.latest;

  view.unmount();

  expect(stream.readyState).toBe(FakeEventSource.CLOSED);
});

// ---- A settled task ---------------------------------------------------------------------------

const picked: Extract<TaskOutcome, { kind: "picked" }> = {
  kind: "picked",
  task_id: "7",
  by: VERIFIER,
  winners: [{ account: "alice.testnet", bps: 10_000, amount: "1425000" }],
  fee: "75000",
  scorecard_hash: HASH_B,
  scorecard_uri: `http://api.test/v1/blobs/${HASH_B}`,
};

const settledTask = (rest = {}) =>
  detail(
    { phase: "settled", outcome_kind: "picked", outcome: picked, heldout_commitment: HASH_C },
    {
      entries: [
        revealed("alice.testnet", HASH_A),
        revealed("bob.testnet", HASH_B, { entry_index: 1 }),
      ],
      scorecard: scorecard({ heldout_commitment: HASH_C }),
      ...rest,
    },
  );

test("task_page_shows_who_settled_and_the_scorecard_once_the_task_is_picked", async () => {
  pinClock(AT.fallback + 60n * SECOND);
  fakeApi(routes(() => settledTask()));

  await open();

  expect(screen.getByTestId("phase-chip").textContent).toBe("Settled");
  expect(screen.getByTestId("settled-by").textContent).toBe(`Picked by ${VERIFIER} (verifier)`);
  expect(screen.getAllByTestId("winner-row")).toHaveLength(1);
  // The line asks for the commitment the task has on chain.
  expect(screen.getByTestId("recompute").textContent).toBe(
    `Recompute: sha256(held-out) must equal ${HASH_C}`,
  );
  expect(screen.queryByTestId("commitment-mismatch")).toBeNull();
  expect(screen.getAllByTestId("score-row")).toHaveLength(2);
  // The reveal window is long over: both entries link to their content.
  expect(screen.getAllByRole("link", { name: /open content/i })).toHaveLength(2);
  expect(screen.getByTestId("live-status").textContent).toBe("Settled.");
});

test("task_page_flags_a_scorecard_whose_commitment_is_not_the_tasks", async () => {
  pinClock(AT.fallback + 60n * SECOND);
  fakeApi(routes(() => settledTask({ scorecard: scorecard({ heldout_commitment: HASH_A }) })));

  await open();

  expect(screen.getByTestId("recompute").textContent).toContain(HASH_C);
  expect(screen.getByTestId("commitment-mismatch").textContent).toContain(HASH_A);
});

test("task_page_says_so_when_a_settled_task_has_no_scorecard_to_show", async () => {
  pinClock(AT.fallback + 60n * SECOND);
  fakeApi(routes(() => settledTask({ scorecard: null })));

  await open();

  expect(screen.queryByTestId("scorecard")).toBeNull();
  const missing = screen.getByTestId("scorecard-missing");
  expect(missing.textContent).toContain("not available");
  expect(missing.textContent).toContain(HASH_B);
});

test("task_page_shows_a_refund_when_the_task_was_voided", async () => {
  pinClock(AT.fallback + 60n * SECOND);
  const voided: TaskOutcome = {
    kind: "voided",
    task_id: "7",
    reason: "expired",
    by: null,
    refunds: [{ account: POSTER, amount: "1500000" }],
    scorecard_hash: null,
    scorecard_uri: null,
  };
  fakeApi(
    routes(() =>
      detail({ phase: "settled", outcome_kind: "voided", outcome: voided }, { entries: [] }),
    ),
  );

  await open();

  expect(screen.getByTestId("settled-by").textContent).toBe("Refunded");
  expect(screen.getByTestId("settled-why").textContent).toBe(
    "Nobody picked before the fallback window closed.",
  );
  expect(screen.getAllByTestId("refund-row")).toHaveLength(1);
  // A void that anyone called has no scorecard, and the page does not look for one.
  expect(screen.queryByTestId("scorecard")).toBeNull();
  expect(screen.queryByTestId("scorecard-missing")).toBeNull();
});

test("task_page_marks_a_task_that_has_an_outcome_as_settled_whatever_the_clock_says", async () => {
  // Before the commit deadline, which would make it open, if it had no outcome.
  pinClock(AT.created + 5n * SECOND);
  fakeApi(routes(() => settledTask()));

  await open();

  expect(screen.getByTestId("phase-chip").textContent).toBe("Settled");
});
