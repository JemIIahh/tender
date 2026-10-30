import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import Home from "../app/page";

// The placeholder board over a fake API. 06-T2 replaces the board; the states stay.

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

/** A `fetch` that gives the answers in turn, the last one for any call after them. */
function fakeApi(...answers: Array<Response | Error>): { calls: () => number } {
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    const answer = answers[Math.min(calls, answers.length - 1)];
    calls++;
    if (answer instanceof Error) throw answer;
    return answer?.clone();
  });
  return { calls: () => calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
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
  expect(first.getByText("open")).toBeTruthy();
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
  fakeApi(new TypeError("Failed to fetch"));

  render(<Home />);

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/can't reach/i);
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
