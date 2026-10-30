import { ApiError } from "@tender/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import Home from "../app/page";

// The board over a fake API: what it shows for each state of the request, and how its filters
// and its paging ask the API.

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

afterEach(() => {
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

  render(<Home />);

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

  render(<Home />);

  const card = within(await screen.findByTestId("task-card"));
  expect(card.getByText(/no public brief yet/i)).toBeTruthy();
});

test("board_says_when_there_are_no_tasks", async () => {
  fakeApi(json(page()));

  render(<Home />);

  expect(await screen.findByText(/no tasks yet/i)).toBeTruthy();
  expect(screen.queryByTestId("task-card")).toBeNull();
});

test("board_shows_that_it_is_loading_until_the_api_answers", async () => {
  fakeApi(json(page(TASK)));

  render(<Home />);

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
  render(<Home />);

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

  render(<Home />);

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/can't reach/i);
});

test("board_logs_the_error_behind_the_words_it_shows", async () => {
  const log = quietLog();
  fakeApi(json({ error: "unavailable", message: "db down at 10.0.3.7" }, 503));

  render(<Home />);

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

  render(<Home />);

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
  render(<Home />);
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
      <Home />
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

  render(<Home />);

  const cards = await screen.findAllByTestId("task-card");
  const titled = within(cards[0] as HTMLElement).getByRole("link", {
    name: "Extract invoice totals",
  });
  expect(titled.getAttribute("href")).toBe("/tasks/7");
  // A task with no public brief has a page too: its title is the stand-in.
  const untitled = within(cards[1] as HTMLElement).getByRole("link", {
    name: /no public brief yet/i,
  });
  expect(untitled.getAttribute("href")).toBe("/tasks/8");
});

test("board_shows_the_judges_reason_whenever_there_is_one", async () => {
  fakeApi(
    json(
      page(
        {
          ...TASK,
          id: "1",
          judge_status: "accepted",
          judge_reason: "not judged: needs a held-out part",
        },
        { ...TASK, id: "2", judge_status: null, judge_reason: "waiting for the Judge" },
        { ...TASK, id: "3", judge_status: "accepted", judge_reason: null },
        { ...TASK, id: "4", judge_status: null, judge_reason: null },
      ),
    ),
  );

  render(<Home />);

  const notes = (await screen.findAllByTestId("task-card")).map(
    (card) => within(card).queryByTestId("judge-note")?.textContent ?? null,
  );
  // The reason is shown for an accepted task too: the Judge says why before agents spend effort.
  expect(notes).toEqual([
    "Judge: accepted · not judged: needs a held-out part",
    "Judge: waiting for the Judge",
    "Judge: accepted",
    null,
  ]);
});

test("board_shows_the_judges_words_as_text_never_as_html", async () => {
  fakeApi(json(page({ ...TASK, judge_reason: '<img src=x onerror="alert(1)">' })));

  render(<Home />);

  await screen.findByTestId("task-card");
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByTestId("judge-note").textContent).toContain('<img src=x onerror="alert(1)">');
});

// ---- Filters ----------------------------------------------------------------------------------

test("board_phase_chips_ask_the_api_for_that_phase", async () => {
  const api = fakeApi(json(page(TASK)));
  render(<Home />);
  await screen.findByTestId("task-card");
  const group = screen.getByRole("group", { name: "Phase" });
  const pressed = () =>
    within(group)
      .getAllByRole("button")
      .map((chip) => `${chip.textContent}:${chip.getAttribute("aria-pressed")}`);
  // All the tasks to begin with, as the API lists them when no phase is asked for.
  expect(pressed()).toEqual([
    "All:true",
    "Open:false",
    "Revealing:false",
    "Judging:false",
    "Settled:false",
  ]);
  expect(query(api, 0).has("phase")).toBe(false);

  await userEvent.click(within(group).getByRole("button", { name: "Revealing" }));

  await waitFor(() => expect(api.urls).toHaveLength(2));
  expect(query(api, 1).get("phase")).toBe("revealing");
  expect(pressed()).toEqual([
    "All:false",
    "Open:false",
    "Revealing:true",
    "Judging:false",
    "Settled:false",
  ]);

  await userEvent.click(within(group).getByRole("button", { name: "All" }));

  await waitFor(() => expect(api.urls).toHaveLength(3));
  expect(query(api, 2).has("phase")).toBe(false);
});

test("board_filters_by_tag", async () => {
  const api = fakeApi(json(page(TASK)));
  render(<Home />);
  await screen.findByTestId("task-card");

  // Case and the spaces around a tag do not matter, as a person types it.
  await userEvent.type(screen.getByLabelText("Tag"), "  JSON {Enter}");

  await waitFor(() => expect(api.urls).toHaveLength(2));
  expect(query(api, 1).get("tag")).toBe("json");

  await userEvent.click(screen.getByRole("button", { name: "Clear" }));

  await waitFor(() => expect(api.urls).toHaveLength(3));
  expect(query(api, 2).has("tag")).toBe(false);
  expect((screen.getByLabelText("Tag") as HTMLInputElement).value).toBe("");
  expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
});

test("board_keeps_the_phase_when_the_tag_changes_and_the_tag_when_the_phase_does", async () => {
  const api = fakeApi(json(page(TASK)));
  render(<Home />);
  await screen.findByTestId("task-card");

  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  await waitFor(() => expect(api.urls).toHaveLength(2));
  await userEvent.type(screen.getByLabelText("Tag"), "json{Enter}");
  await waitFor(() => expect(api.urls).toHaveLength(3));
  expect(query(api, 2).get("phase")).toBe("open");
  expect(query(api, 2).get("tag")).toBe("json");

  await userEvent.click(screen.getByRole("button", { name: "Settled" }));

  await waitFor(() => expect(api.urls).toHaveLength(4));
  expect(query(api, 3).get("phase")).toBe("settled");
  expect(query(api, 3).get("tag")).toBe("json");
});

test("board_does_not_ask_for_a_tag_the_api_would_refuse", async () => {
  const api = fakeApi(json(page(TASK)));
  render(<Home />);
  await screen.findByTestId("task-card");

  await userEvent.type(screen.getByLabelText("Tag"), "not a tag!{Enter}");

  // The person is told what a tag looks like, next to the field, and nothing is sent.
  expect(screen.getByTestId("tag-error").textContent).toBe(
    "A tag is 1 to 24 characters: a to z, 0 to 9 and -.",
  );
  expect(api.urls).toHaveLength(1);
  // The message is not an alert: the board has one alert at a time, for a request that failed.
  expect(screen.queryByRole("alert")).toBeNull();
});

test("board_filters_by_the_tag_of_a_card_when_it_is_pressed", async () => {
  const api = fakeApi(json(page(TASK)));
  render(<Home />);
  const card = within(await screen.findByTestId("task-card"));

  await userEvent.click(card.getByRole("button", { name: "json" }));

  await waitFor(() => expect(api.urls).toHaveLength(2));
  expect(query(api, 1).get("tag")).toBe("json");
  expect((screen.getByLabelText("Tag") as HTMLInputElement).value).toBe("json");
});

test("board_says_when_no_task_matches_the_filters", async () => {
  fakeApi(json(page(TASK)), json(page()));
  render(<Home />);
  await screen.findByTestId("task-card");

  await userEvent.click(screen.getByRole("button", { name: "Settled" }));

  expect(await screen.findByText(/no tasks match/i)).toBeTruthy();
  expect(screen.queryByText(/no tasks yet/i)).toBeNull();
});

test("board_drops_the_answer_to_a_filter_that_is_no_longer_the_one_asked_for", async () => {
  const pending: Array<(response: Response) => void> = [];
  vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => pending.push(resolve)));
  render(<Home />);
  await waitFor(() => expect(pending).toHaveLength(1));

  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  await waitFor(() => expect(pending).toHaveLength(2));
  pending[1]?.(json(page({ ...TASK, title: "Answer for Open" })));
  await screen.findByText("Answer for Open");
  pending[0]?.(json(page({ ...TASK, title: "Answer for All" })));
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(screen.queryByText("Answer for All")).toBeNull();
  expect(screen.getByText("Answer for Open")).toBeTruthy();
});

// ---- More pages -------------------------------------------------------------------------------

test("board_loads_the_next_page_with_the_cursor_the_api_gave", async () => {
  const api = fakeApi(
    json({ tasks: [TASK], next_cursor: "7" }),
    json({ tasks: [{ ...TASK, id: "6", title: "An older task" }], next_cursor: null }),
  );
  render(<Home />);
  await screen.findByTestId("task-card");
  expect(query(api, 0).has("cursor")).toBe(false);

  await userEvent.click(screen.getByRole("button", { name: "Load more" }));

  await screen.findByText("An older task");
  expect(query(api, 1).get("cursor")).toBe("7");
  expect(screen.getAllByTestId("task-card")).toHaveLength(2);
  // That was the last page.
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

test("board_has_no_load_more_on_the_last_page", async () => {
  fakeApi(json(page(TASK)));
  render(<Home />);

  await screen.findByTestId("task-card");

  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

test("board_keeps_its_tasks_when_the_next_page_fails_and_offers_a_retry", async () => {
  quietLog();
  const api = fakeApi(
    json({ tasks: [TASK], next_cursor: "7" }),
    json({ error: "internal", message: "internal error" }, 500),
    json({ tasks: [{ ...TASK, id: "6", title: "An older task" }], next_cursor: null }),
  );
  render(<Home />);
  await screen.findByTestId("task-card");

  await userEvent.click(screen.getByRole("button", { name: "Load more" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("500");
  expect(screen.getAllByTestId("task-card")).toHaveLength(1);

  await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));

  await screen.findByText("An older task");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(query(api, 2).get("cursor")).toBe("7");
});
