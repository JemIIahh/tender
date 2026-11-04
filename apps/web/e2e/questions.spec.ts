import { expect, type Page, test } from "@playwright/test";
import type { Question } from "@tender/shared";
import { AT, agent, SECOND } from "../test/tasks";
import { emptyBoard, routeApi } from "./fixtures";
import { installInjectedWallet } from "./injectedWallet";
import { routeBoardWrites } from "./questionsApi";
import { STUB_WALLET_NAME } from "./walletStub";

// The question board on the task page (spec 7.2.1), against the fixture API and its stream: what a
// reader sees and hears live, what an entrant and the poster can do through the real wallet picker
// and sign-in, and the board after the commit deadline.

const TASK = "/tasks/2";
const ALICE = "alice.testnet";
const POSTER = "poster.tender-team.testnet";
const NOTE = "Answers explain the brief; they can't change the checks.";

/** The time `ns` nanoseconds after the epoch, as Playwright's clock takes one. */
const at = (ns: bigint) => new Date(Number(ns / 1_000_000n));
const OPEN = at(AT.created + 60n * SECOND);

const question = (id: string, overrides: Partial<Question> = {}): Question => ({
  id,
  asker: "bob.testnet",
  text: `Question ${id}?`,
  asked_at: "2026-11-03T10:00:00.000Z",
  hidden: false,
  answer: null,
  ...overrides,
});

const board = (page: Page) => page.getByTestId("questions");

/** Picks the spec's wallet in near-connect's list from the board's own Connect button. */
async function connect(page: Page): Promise<void> {
  await board(page).getByRole("button", { name: "Connect wallet" }).click();
  await page.locator(".hot-connector-popup .connect-item", { hasText: STUB_WALLET_NAME }).click();
}

test("question_board_shows_answers_hidden_items_and_updates_live", async ({ page }) => {
  await page.clock.install({ time: OPEN });
  const api = await routeApi(page);
  const hostile = "<b>not bold</b> **not strong** https://evil.test";
  api.boards.set("2", {
    ...emptyBoard("2"),
    questions: [
      question("1", {
        text: "Must the regex accept implicit accounts?",
        answer: { text: "Yes: 64 hex characters.", answered_at: "2026-11-03T11:00:00.000Z" },
      }),
      question("2", { asker: "spam.testnet", hidden: true, text: null }),
    ],
    clarifications: [
      { id: "3", text: "Sub-accounts count as valid.", posted_at: "2026-11-03T09:00:00.000Z" },
    ],
  });
  await page.goto(TASK);
  // A mark on the page itself: it is still there at the end only if the page was never reloaded.
  await page.evaluate(() => {
    (window as unknown as { kept: boolean }).kept = true;
  });

  await expect(board(page).getByTestId("board-note")).toHaveText(NOTE);
  await expect(board(page).getByTestId("board-summary")).toHaveText(
    "2 questions · 1 clarification",
  );
  const rows = board(page).getByTestId("question");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByTestId("question-text")).toHaveText(
    "Must the regex accept implicit accounts?",
  );
  await expect(rows.nth(0).getByTestId("answer-text")).toHaveText("Yes: 64 hex characters.");
  await expect(rows.nth(1).getByTestId("question-hidden")).toHaveText("hidden by the poster");
  await expect(rows.nth(1).getByTestId("asker")).toHaveText("spam.testnet");
  await expect(board(page).getByTestId("clarification-text")).toHaveText(
    "Sub-accounts count as valid.",
  );

  // Someone asks: the stream says so, with no text, and the page reads the board again.
  api.boards.set("2", {
    ...(api.boards.get("2") ?? emptyBoard("2")),
    questions: [...(api.boards.get("2")?.questions ?? []), question("4", { text: hostile })],
  });
  api.boardEvent({
    event: "question_asked",
    data: { task_id: "2", question_id: "4", asker: "bob.testnet" },
  });
  await expect(rows).toHaveCount(3);
  // A stranger's words are text: no markup, no link.
  await expect(rows.nth(2).getByTestId("question-text")).toHaveText(hostile);
  await expect(rows.nth(2).locator("b, strong, a")).toHaveCount(0);

  // The poster hides it, in another tab: it goes to the label here too.
  api.boards.set("2", {
    ...(api.boards.get("2") ?? emptyBoard("2")),
    questions: (api.boards.get("2")?.questions ?? []).map((one) =>
      one.id === "4" ? { ...one, hidden: true, text: null } : one,
    ),
  });
  api.boardEvent({ event: "question_hidden", data: { task_id: "2", question_id: "4" } });
  await expect(rows.nth(2).getByTestId("question-hidden")).toHaveText("hidden by the poster");
  await expect(rows.nth(2).getByTestId("asker")).toHaveText("bob.testnet");

  // All of it without a reload.
  expect(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true);
});

test("entrant_asks_with_a_live_count_and_reads_a_refusal_plainly", async ({ page }) => {
  await page.clock.install({ time: OPEN });
  const api = await routeApi(page);
  // Alice is a registered agent, so the page offers her the form on this open task.
  api.agents.set(ALICE, { agent: agent({ account: ALICE }), recent_entries: [] });
  const wallet = await installInjectedWallet(page, { account: ALICE });
  const writes = await routeBoardWrites(page, api, ALICE);
  await page.goto(TASK);
  await expect(board(page).getByTestId("board-empty")).toHaveText("No questions yet.");

  await connect(page);
  const field = board(page).getByLabel("Ask the poster");
  await expect(field).toBeVisible();
  await expect(board(page).getByTestId("char-count")).toHaveText("0 / 1,000");

  const text = "Must the regex accept implicit accounts?";
  await field.fill(text);
  await expect(board(page).getByTestId("char-count")).toHaveText(`${text.length} / 1,000`);
  // Ask from the keyboard: Tab goes from the field to the button, and its focus ring shows.
  const ask = board(page).getByRole("button", { name: "Ask" });
  await page.keyboard.press("Tab");
  await expect(ask).toBeFocused();
  const outline = await ask.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  expect(outline.style).not.toBe("none");
  expect(outline.width).toBeGreaterThanOrEqual(2);
  await page.keyboard.press("Enter");

  await expect(board(page).getByTestId("question-text")).toHaveText(text);
  await expect(board(page).getByTestId("question").getByTestId("asker")).toHaveText(ALICE);
  await expect(board(page).getByRole("status")).toHaveText("Your question is on the board.");
  // It signed in first, once, then asked with the token.
  expect(writes.requests).toEqual([
    "POST /v1/auth/challenge",
    "POST /v1/auth/verify",
    "POST /v1/tasks/2/questions",
  ]);
  expect(wallet.signed).toHaveLength(1);
  await expect(field).toHaveValue("");

  // The API turns the next one away: the page says why, in plain words.
  writes.refuse("ask", {
    status: 403,
    error: "not_registered",
    message: "only a registered agent can ask a question on an open task",
  });
  await field.fill("And sub-accounts?");
  await ask.click();
  await expect(board(page).getByRole("alert")).toHaveText(
    "Only a registered, active agent can ask on an open task, and this account isn't one.",
  );
  writes.refuse("ask", {
    status: 429,
    error: "rate_limited",
    message: "an account may ask 5 questions an hour on a task, and you have; try again later",
  });
  await ask.click();
  await expect(board(page).getByRole("alert")).toHaveText(
    "An account can ask 5 questions an hour on a task. Try again later.",
  );
  await expect(board(page).getByTestId("question")).toHaveCount(1);

  // Over the limit the count says so and the button waits; nothing is sent.
  const sent = writes.requests.length;
  await field.fill("a".repeat(1001));
  await expect(board(page).getByTestId("char-count")).toHaveText("1,001 / 1,000");
  await expect(board(page).getByText("The text is over 1,000 characters.")).toBeVisible();
  await expect(ask).toHaveAttribute("aria-disabled", "true");
  // Pressed all the same (a held button still takes a press): nothing goes out.
  await ask.click({ force: true });
  // An invisible character is refused before it is sent, and named.
  await field.fill(`Is it${String.fromCodePoint(0x200b)} fine?`);
  await expect(
    board(page).getByText("The text has an invisible character (U+200B). Delete it and try again."),
  ).toBeVisible();
  await ask.click({ force: true });
  expect(writes.requests).toHaveLength(sent);
});

test("an_unregistered_account_is_told_why_and_asked_for_no_signature", async ({ page }) => {
  await page.clock.install({ time: OPEN });
  const api = await routeApi(page);
  const wallet = await installInjectedWallet(page, { account: ALICE });
  const writes = await routeBoardWrites(page, api, ALICE);
  await page.goto(TASK);
  await connect(page);

  // The page read Alice's agent record before offering anything: she has none.
  const why = board(page).getByTestId("board-role");
  await expect(why).toHaveText("Only registered agents can ask on open tasks. My agents");
  await expect(why.getByRole("link", { name: "My agents" })).toHaveAttribute("href", "/my-agents");
  await expect(board(page).getByTestId("ask-form")).toHaveCount(0);
  expect(api.requests).toContain(`GET /v1/agents/${ALICE}`);
  // Nothing was signed or sent.
  expect(wallet.signed).toEqual([]);
  expect(writes.requests).toEqual([]);
});

test("poster_answers_hides_and_posts_a_clarification", async ({ page }) => {
  await page.clock.install({ time: OPEN });
  const api = await routeApi(page);
  await installInjectedWallet(page, { account: POSTER });
  const writes = await routeBoardWrites(page, api, POSTER);
  api.boards.set("2", {
    ...emptyBoard("2"),
    questions: [
      question("1", { text: "Must it accept implicit accounts?" }),
      question("2", { asker: "spam.testnet", text: "Buy my token" }),
    ],
  });
  await page.goto(TASK);
  await connect(page);

  // The poster's controls, and no Ask form: the poster answers.
  await expect(board(page).getByTestId("clarify-form")).toBeVisible();
  await expect(board(page).getByTestId("ask-form")).toHaveCount(0);
  const [first, second] = [
    board(page).getByTestId("question").nth(0),
    board(page).getByTestId("question").nth(1),
  ];

  await first.getByRole("button", { name: "Answer" }).click();
  const answer = first.getByLabel("Your answer");
  await expect(answer).toBeFocused();
  await answer.fill("Yes: 64 hex characters.");
  await first.getByRole("button", { name: "Post answer" }).click();
  await expect(first.getByTestId("answer-text")).toHaveText("Yes: 64 hex characters.");
  await expect(first).toBeFocused();

  await second.getByRole("button", { name: "Hide" }).click();
  await expect(second.getByRole("button", { name: "Keep" })).toBeFocused();
  await second.getByRole("button", { name: "Yes, hide" }).click();
  await expect(second.getByTestId("question-hidden")).toHaveText("hidden by the poster");
  await expect(second.getByTestId("asker")).toHaveText("spam.testnet");
  await expect(second.getByRole("button")).toHaveCount(0);

  await board(page).getByLabel("Post a clarification").fill("Sub-accounts count as valid.");
  await board(page).getByRole("button", { name: "Post", exact: true }).click();
  await expect(board(page).getByTestId("clarification-text")).toHaveText(
    "Sub-accounts count as valid.",
  );

  expect(writes.requests.filter((request) => request.includes("/v1/tasks/"))).toEqual([
    "POST /v1/tasks/2/questions/1/answer",
    "POST /v1/tasks/2/questions/2/hide",
    "POST /v1/tasks/2/clarifications",
  ]);
});

test("board_is_read_only_after_the_commit_deadline_and_says_why", async ({ page }) => {
  await page.clock.install({ time: at(AT.commit + 30n * SECOND) });
  const api = await routeApi(page);
  api.boards.set("2", { ...emptyBoard("2", false), questions: [question("1")] });
  await page.goto(TASK);

  await expect(board(page).getByTestId("board-read-only")).toHaveText(
    "The commit deadline has passed, so this board is read-only: no new questions, answers or clarifications.",
  );
  await expect(board(page).getByTestId("question-text")).toHaveText("Question 1?");
  await expect(board(page).getByRole("button")).toHaveCount(0);
  await expect(board(page).getByRole("textbox")).toHaveCount(0);
});
