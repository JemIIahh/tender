import {
  BOARD_HIDDEN_LABEL,
  BOARD_NOTE,
  type Phase,
  type Question,
  SIGN_IN_MESSAGE,
  type TaskBoard,
} from "@tender/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Questions } from "../components/Questions";
import { keepToken, signInTicket } from "../lib/apiToken";
import { clearApiToken } from "../lib/auth";
import { createWalletStore, type Session, type WalletStore } from "../lib/wallet";
import { FakeChain } from "./fakeChain";
import { POSTER, VERIFIER } from "./tasks";
import { chainWallet, type FakeProvider, fakeProvider } from "./walletDoubles";

// The task page's question board (spec 7.2.1) over a fake API and a wallet double: what a reader,
// an entrant and the poster see and can do in each state of the board, and what the page says when
// the API turns a write away.

const ALICE = "alice.testnet";
const TASK = { id: "7", poster: POSTER, verifier: VERIFIER, invited: [] as string[] };
const BOARD_PATH = "/v1/tasks/7/questions";
const NONCE = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));

// The board reads the wallet from `lib/wallet`; the tests hand it a store of their own.
const holder = vi.hoisted(() => ({ store: undefined as unknown as WalletStore }));
vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return {
    ...actual,
    useWallet: (options?: { start?: boolean }) => actual.useWalletStore(holder.store, options),
  };
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const refusal = (status: number, error: string, message: string, issues?: unknown[]) =>
  json(issues === undefined ? { error, message } : { error, message, issues }, status);

function question(id: string, overrides: Partial<Question> = {}): Question {
  return {
    id,
    asker: "bob.testnet",
    text: `Question ${id}?`,
    asked_at: "2026-11-03T10:00:00.000Z",
    hidden: false,
    answer: null,
    ...overrides,
  };
}

function board(overrides: Partial<TaskBoard> = {}): TaskBoard {
  return {
    task_id: "7",
    open: true,
    questions: [],
    clarifications: [],
    hidden_label: BOARD_HIDDEN_LABEL,
    note: BOARD_NOTE,
    ...overrides,
  };
}

/** A write's own answer, or undefined to have it taken as the API takes it. */
type Write = (body: { text?: string }, call: number) => Response | undefined;

interface FakeApi {
  board: TaskBoard;
  /** `METHOD /path` of each request, in order. */
  requests: string[];
  /** The `Authorization` header of each write to the board, in order. */
  authorizations: (string | null)[];
}

/**
 * An API with `start` as the board. A write is taken as the API takes it, unless `writes` answers
 * for its path (`ask`, `answer`, `hide`, `clarify`) first.
 */
function fakeApi(
  start: TaskBoard = board(),
  writes: Partial<Record<"ask" | "answer" | "hide" | "clarify", Write>> = {},
  read: () => Response | undefined = () => undefined,
): FakeApi {
  const api: FakeApi = { board: start, requests: [], authorizations: [] };
  const calls = { ask: 0, answer: 0, hide: 0, clarify: 0 };
  const at = "2026-11-03T12:00:00.000Z";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    const method = init.method ?? "GET";
    api.requests.push(`${method} ${path}`);
    if (method === "GET" && path === BOARD_PATH) return read() ?? json(api.board);
    if (path === "/v1/auth/challenge") {
      return json({
        nonce: NONCE,
        message: SIGN_IN_MESSAGE,
        recipient: "http://api.test",
        expires_at: "2099-01-01T00:00:00.000Z",
      });
    }
    if (path === "/v1/auth/verify") {
      return json({
        token: "tok-1",
        expires_at: "2099-01-01T00:00:00.000Z",
        key_kind: "full_access",
      });
    }
    api.authorizations.push(new Headers(init.headers).get("Authorization"));
    const body = (init.body === undefined ? {} : JSON.parse(String(init.body))) as {
      text?: string;
    };
    const route =
      /^\/v1\/tasks\/7\/(?:questions(?:\/(\d+)\/(answer|hide))?|(clarifications))$/.exec(path);
    const kind = route?.[3] ? "clarify" : route?.[2] ? (route[2] as "answer" | "hide") : "ask";
    calls[kind] += 1;
    const answered = writes[kind]?.(body, calls[kind]);
    if (answered !== undefined) return answered;
    if (kind === "ask") {
      const asked = question(String(api.board.questions.length + 1), {
        asker: ALICE,
        text: (body.text ?? "").trim(),
        asked_at: at,
      });
      api.board = { ...api.board, questions: [...api.board.questions, asked] };
      return json({ question: asked });
    }
    if (kind === "clarify") {
      const posted = { id: "90", text: (body.text ?? "").trim(), posted_at: at };
      api.board = { ...api.board, clarifications: [...api.board.clarifications, posted] };
      return json({ clarification: posted });
    }
    const id = route?.[1] ?? "";
    const found = api.board.questions.find((one) => one.id === id);
    if (found === undefined) return refusal(404, "not_found", "no such question");
    const changed: Question =
      kind === "hide"
        ? { ...found, hidden: true, text: null, answer: null }
        : { ...found, answer: { text: (body.text ?? "").trim(), answered_at: at } };
    api.board = {
      ...api.board,
      questions: api.board.questions.map((one) => (one.id === id ? changed : one)),
    };
    return json({ question: changed });
  });
  return api;
}

/** A store over a wallet for `account`: connected from an earlier visit with `restored`. */
function wallet(account: string, options: { restored?: boolean; signMessage?: boolean } = {}) {
  const session: Session = {
    wallet: chainWallet(new FakeChain("tender.testnet", []), account, {
      signMessage: options.signMessage,
    }),
    accountId: account,
  };
  const provider = fakeProvider(session, { restored: options.restored });
  const restore = vi.spyOn(provider, "restore");
  holder.store = createWalletStore(async () => provider);
  return { provider, restore };
}

/** The board of task 7 in `phase`, connected as `account` (already, from an earlier visit). */
async function connectedAs(account: string, phase: Phase = "open") {
  const made = wallet(account, { restored: true });
  render(<Questions task={TASK} phase={phase} refresh={0} />);
  await act(() => holder.store.start());
  return made;
}

const section = () => screen.getByTestId("questions");
const loaded = () => screen.findAllByTestId(/^(board-empty|question)$/);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearApiToken();
  sessionStorage.clear();
});

// ---- What everyone sees -------------------------------------------------------------------------

test("board_empty_shows_the_fixed_note_and_asks_a_reader_to_connect", async () => {
  const api = fakeApi();
  const { restore } = wallet(ALICE);
  render(<Questions task={TASK} phase="open" refresh={0} />);

  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Questions");
  expect((await screen.findByTestId("board-empty")).textContent).toBe("No questions yet.");
  expect(screen.getByTestId("board-note").textContent).toBe(
    "Answers explain the brief; they can't change the checks.",
  );
  // A reader is offered the way in, and no form; nothing announces itself as a status.
  expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy();
  expect(screen.queryByTestId("ask-form")).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  // Reading the board looks for no wallet: this tab never signed in.
  expect(restore).not.toHaveBeenCalled();
  expect(api.requests).toEqual([`GET ${BOARD_PATH}`]);
});

test("board_shows_every_question_its_asker_time_and_answer_and_the_clarifications", async () => {
  fakeApi(
    board({
      questions: [
        question("1", {
          asker: "carol.testnet",
          text: "Is the total with tax?",
          answer: { text: "Without tax.", answered_at: "2026-11-03T11:00:00.000Z" },
        }),
        question("2", { text: "May I use a library?" }),
      ],
      clarifications: [
        { id: "3", text: "Amounts are in euros.", posted_at: "2026-11-03T09:00:00.000Z" },
      ],
    }),
  );
  wallet(ALICE);
  render(<Questions task={TASK} phase="open" refresh={0} />);
  await loaded();

  expect(screen.getByTestId("board-summary").textContent).toBe("2 questions · 1 clarification");
  const rows = screen.getAllByTestId("question");
  expect(rows).toHaveLength(2);
  const [first, second] = rows as [HTMLElement, HTMLElement];
  expect(within(first).getByTestId("asker").textContent).toBe("carol.testnet");
  expect(within(first).getAllByRole("time")[0]?.getAttribute("datetime")).toBe(
    "2026-11-03T10:00:00.000Z",
  );
  expect(within(first).getByTestId("question-text").textContent).toBe("Is the total with tax?");
  const answer = within(first).getByTestId("question-answer");
  expect(within(answer).getByTestId("answer-text").textContent).toBe("Without tax.");
  expect(within(answer).getByText("Poster's answer")).toBeTruthy();
  expect(within(second).getByTestId("question-unanswered").textContent).toBe("Not answered yet");
  const clarification = screen.getByTestId("clarification");
  expect(within(clarification).getByTestId("clarification-text").textContent).toBe(
    "Amounts are in euros.",
  );
  expect(within(clarification).getByRole("time").getAttribute("datetime")).toBe(
    "2026-11-03T09:00:00.000Z",
  );
});

test("board_text_is_plain_text_no_html_no_markdown_no_links", async () => {
  const hostile =
    '<b>bold</b> <img src=x onerror="alert(1)"> **strong** [link](https://evil.test) https://evil.test\nline two';
  fakeApi(
    board({
      questions: [
        question("1", {
          text: hostile,
          answer: { text: "<script>x()</script> _no_", answered_at: "2026-11-03T11:00:00.000Z" },
        }),
      ],
      clarifications: [{ id: "2", text: "# not a heading", posted_at: "2026-11-03T09:00:00.000Z" }],
    }),
  );
  wallet(ALICE);
  render(<Questions task={TASK} phase="open" refresh={0} />);
  await loaded();

  // Every character is there as it was written, line break included, and nothing became markup.
  expect(screen.getByTestId("question-text").textContent).toBe(hostile);
  expect(screen.getByTestId("answer-text").textContent).toBe("<script>x()</script> _no_");
  expect(screen.getByTestId("clarification-text").textContent).toBe("# not a heading");
  const shown = section();
  for (const tag of ["b", "img", "script", "strong", "em", "h1", "a"]) {
    expect(shown.querySelector(tag), tag).toBeNull();
  }
  // The line break shows as one: the text keeps its white space.
  expect(screen.getByTestId("question-text").className).toContain("whitespace-pre-wrap");
});

test("board_shows_a_hidden_question_as_hidden_by_the_poster_with_its_asker", async () => {
  fakeApi(
    board({
      questions: [question("1", { asker: "spam.testnet", hidden: true, text: null, answer: null })],
    }),
  );
  wallet(ALICE);
  render(<Questions task={TASK} phase="open" refresh={0} />);
  const row = await screen.findByTestId("question");

  expect(within(row).getByTestId("question-hidden").textContent).toBe("hidden by the poster");
  expect(within(row).getByTestId("asker").textContent).toBe("spam.testnet");
  expect(within(row).queryByTestId("question-text")).toBeNull();
  expect(within(row).queryByTestId("question-answer")).toBeNull();
  expect(within(row).queryByTestId("question-unanswered")).toBeNull();
});

test("board_shows_only_the_label_for_a_hidden_question_whatever_the_row_carries", async () => {
  // The API sends a hidden question with no text and no answer. A server that sent them along
  // still has them shown as hidden.
  fakeApi(
    board({
      questions: [
        question("1", {
          asker: "spam.testnet",
          hidden: true,
          text: "Buy my token",
          answer: { text: "Never.", answered_at: "2026-11-03T11:00:00.000Z" },
        }),
      ],
    }),
  );
  wallet(ALICE);
  render(<Questions task={TASK} phase="open" refresh={0} />);
  const row = await screen.findByTestId("question");

  expect(within(row).getByTestId("question-hidden").textContent).toBe("hidden by the poster");
  expect(row.textContent).not.toContain("Buy my token");
  expect(row.textContent).not.toContain("Never.");
  expect(within(row).getByTestId("asker").textContent).toBe("spam.testnet");
});

test("board_is_read_only_after_the_commit_deadline_and_says_why", async () => {
  fakeApi(board({ open: false, questions: [question("1")] }));
  await connectedAs(POSTER, "revealing");
  await loaded();

  expect(screen.getByTestId("board-read-only").textContent).toBe(
    "The commit deadline has passed, so this board is read-only: no new questions, answers or clarifications.",
  );
  // No form and no control for anyone, the poster included.
  for (const id of ["ask-form", "clarify-form", "answer-form"]) {
    expect(screen.queryByTestId(id), id).toBeNull();
  }
  expect(within(section()).queryAllByRole("button")).toEqual([]);
});

test("board_is_read_only_by_the_clock_even_when_the_api_said_open_a_moment_ago", async () => {
  fakeApi(board({ open: true }));
  wallet(ALICE);
  render(<Questions task={TASK} phase="revealing" refresh={0} />);
  await loaded();

  expect(screen.getByTestId("board-read-only")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Connect wallet" })).toBeNull();
});

// ---- An entrant -------------------------------------------------------------------------------

test("entrant_asks_with_a_live_count_signs_in_once_and_the_question_appears", async () => {
  const api = fakeApi();
  await connectedAs(ALICE);
  await loaded();
  const user = userEvent.setup();

  const field = screen.getByLabelText("Ask the poster");
  expect(screen.getByTestId("char-count").textContent).toBe("0 / 1,000");
  const ask = screen.getByRole("button", { name: "Ask" });
  expect(ask.getAttribute("aria-disabled")).toBe("true");

  await user.type(field, "  Is VAT included?");
  // Counted as the API counts it: the blanks at the ends do not count.
  expect(screen.getByTestId("char-count").textContent).toBe("16 / 1,000");
  expect(ask.getAttribute("aria-disabled")).toBe("false");
  await user.click(ask);

  const row = await screen.findByTestId("question");
  expect(within(row).getByTestId("question-text").textContent).toBe("Is VAT included?");
  expect(within(row).getByTestId("asker").textContent).toBe(ALICE);
  expect((await screen.findByRole("status")).textContent).toBe("Your question is on the board.");
  expect((field as HTMLTextAreaElement).value).toBe("");
  expect(api.requests).toContain("POST /v1/auth/challenge");
  expect(api.requests).toContain("POST /v1/tasks/7/questions");
  expect(api.authorizations).toEqual(["Bearer tok-1"]);

  // A second question takes the token it has: no second sign-in.
  await user.type(field, "And shipping?");
  await user.click(ask);
  await waitFor(() => expect(screen.getAllByTestId("question")).toHaveLength(2));
  expect(api.requests.filter((request) => request === "POST /v1/auth/verify")).toHaveLength(1);
  expect(api.authorizations).toEqual(["Bearer tok-1", "Bearer tok-1"]);
});

test("ask_form_shows_the_limit_and_holds_the_button_past_1000_characters", async () => {
  const api = fakeApi();
  await connectedAs(ALICE);
  await loaded();
  const field = screen.getByLabelText("Ask the poster");

  // 1000 emoji are 2000 UTF-16 units and 1000 characters: at the limit, and taken.
  fireEvent.change(field, { target: { value: "\u{1F600}".repeat(1000) } });
  expect(screen.getByTestId("char-count").textContent).toBe("1,000 / 1,000");
  expect(screen.getByRole("button", { name: "Ask" }).getAttribute("aria-disabled")).toBe("false");

  fireEvent.change(field, { target: { value: "a".repeat(1001) } });
  const count = screen.getByTestId("char-count");
  expect(count.textContent).toBe("1,001 / 1,000");
  expect(count.className).toContain("text-seal");
  expect(field.getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByText("The text is over 1,000 characters.")).toBeTruthy();
  // The text is kept, to be shortened, and nothing is sent.
  expect((field as HTMLTextAreaElement).value).toHaveLength(1001);
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
  expect(api.requests.some((request) => request.startsWith("POST"))).toBe(false);
});

test("ask_form_refuses_an_invisible_character_before_sending_and_names_it", async () => {
  const api = fakeApi();
  await connectedAs(ALICE);
  await loaded();
  const zeroWidth = String.fromCodePoint(0x200b);

  fireEvent.change(screen.getByLabelText("Ask the poster"), {
    target: { value: `Is${zeroWidth} it fine?` },
  });

  expect(
    screen.getByText("The text has an invisible character (U+200B). Delete it and try again."),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Ask" }).getAttribute("aria-disabled")).toBe("true");
  expect(api.requests.some((request) => request.startsWith("POST"))).toBe(false);
});

test.each([
  [
    "the hourly count",
    refusal(
      429,
      "rate_limited",
      "an account may ask 5 questions an hour on a task, and you have; try again later",
    ),
    "An account can ask 5 questions an hour on a task. Try again later.",
  ],
  [
    "the route limit",
    refusal(429, "rate_limited", "too many requests, try again later"),
    "Too many at once. Wait a minute, then try again.",
  ],
  [
    "the lifetime count",
    refusal(
      429,
      "question_limit",
      "an account may ask 20 questions on a task in all, and you have",
    ),
    "An account can ask 20 questions on a task, and this one has.",
  ],
  [
    "an account that is no registered agent",
    refusal(403, "not_registered", "only a registered agent can ask a question on an open task"),
    "Only a registered, active agent can ask on an open task, and this account isn't one.",
  ],
  [
    "a closed window",
    refusal(
      409,
      "not_open",
      "the board takes writes only while the task is open, and this one is revealing",
    ),
    "The commit deadline has passed, so this board is read-only: no new questions, answers or clarifications.",
  ],
  [
    "an invisible character the page let through",
    refusal(400, "bad_request", "the body does not fit its schema", [
      {
        path: ["text"],
        code: "custom",
        message: "expected plain text, without invisible formatting characters (found U+E0041)",
      },
    ]),
    "The text has an invisible character (U+E0041). Delete it and try again.",
  ],
  [
    "a full board",
    refusal(409, "board_full", "this task's board has all the questions it takes"),
    "This board is full: a task shows 200 questions.",
  ],
])("ask_refusal_for_%s_is_said_plainly", async (_, answer, words) => {
  fakeApi(board(), { ask: () => answer.clone() });
  await connectedAs(ALICE);
  await loaded();
  const user = userEvent.setup();

  await user.type(screen.getByLabelText("Ask the poster"), "Is VAT included?");
  await user.click(screen.getByRole("button", { name: "Ask" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(words);
  // What was typed stays, to be sent again or changed.
  expect((screen.getByLabelText("Ask the poster") as HTMLTextAreaElement).value).toBe(
    "Is VAT included?",
  );
  expect(screen.queryByTestId("question")).toBeNull();
});

test("ask_signs_in_again_once_when_the_api_has_forgotten_the_token", async () => {
  const api = fakeApi(board(), {
    ask: (_, call) => (call === 1 ? refusal(401, "unauthorized", "sign in again") : undefined),
  });
  await connectedAs(ALICE);
  await loaded();
  const user = userEvent.setup();

  await user.type(screen.getByLabelText("Ask the poster"), "Is VAT included?");
  await user.click(screen.getByRole("button", { name: "Ask" }));

  await screen.findByTestId("question");
  expect(api.requests.filter((request) => request === "POST /v1/auth/verify")).toHaveLength(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("the_verifier_and_an_account_the_task_did_not_invite_get_no_ask_form", async () => {
  fakeApi();
  await connectedAs(VERIFIER);
  await loaded();
  expect(screen.getByTestId("board-role").textContent).toBe(
    "You verify this task, so you don't ask questions on it.",
  );
  expect(screen.queryByTestId("ask-form")).toBeNull();
});

test("an_account_a_pinned_task_did_not_invite_gets_no_ask_form", async () => {
  fakeApi();
  wallet(ALICE, { restored: true });
  render(<Questions task={{ ...TASK, invited: ["dave.testnet"] }} phase="open" refresh={0} />);
  await act(() => holder.store.start());
  await loaded();
  expect(screen.getByTestId("board-role").textContent).toBe(
    "Only the accounts this task invited can ask questions.",
  );
  expect(screen.queryByTestId("ask-form")).toBeNull();
});

test("a_wallet_that_cannot_sign_a_message_is_told_so_and_gets_no_form", async () => {
  fakeApi();
  wallet(ALICE, { restored: true, signMessage: false });
  render(<Questions task={TASK} phase="open" refresh={0} />);
  await act(() => holder.store.start());
  await loaded();
  expect(screen.getByTestId("cannot-sign")).toBeTruthy();
  expect(screen.queryByTestId("ask-form")).toBeNull();
});

// ---- The poster --------------------------------------------------------------------------------

test("poster_sees_answer_hide_and_post_a_clarification_and_an_entrant_does_not", async () => {
  fakeApi(
    board({
      questions: [
        question("1"),
        question("2", { answer: { text: "Yes.", answered_at: "2026-11-03T11:00:00.000Z" } }),
      ],
    }),
  );
  await connectedAs(POSTER);
  await loaded();

  const [open, answered] = screen.getAllByTestId("question") as [HTMLElement, HTMLElement];
  expect(within(open).getByRole("button", { name: "Answer" })).toBeTruthy();
  expect(within(open).getByRole("button", { name: "Hide" })).toBeTruthy();
  // An answered question can still be hidden, and has no second answer.
  expect(within(answered).queryByRole("button", { name: "Answer" })).toBeNull();
  expect(within(answered).getByRole("button", { name: "Hide" })).toBeTruthy();
  expect(screen.getByTestId("clarify-form")).toBeTruthy();
  expect(screen.getByLabelText("Post a clarification")).toBeTruthy();
  // The poster answers, and does not ask.
  expect(screen.queryByTestId("ask-form")).toBeNull();
});

test("poster_answers_a_question_and_the_focus_lands_on_it", async () => {
  const api = fakeApi(board({ questions: [question("1")] }));
  await connectedAs(POSTER);
  await loaded();
  const user = userEvent.setup();

  await user.click(screen.getByRole("button", { name: "Answer" }));
  const field = screen.getByLabelText("Your answer");
  expect(document.activeElement).toBe(field);
  await user.type(field, "Without tax.");
  await user.click(screen.getByRole("button", { name: "Post answer" }));

  const answer = await screen.findByTestId("question-answer");
  expect(within(answer).getByTestId("answer-text").textContent).toBe("Without tax.");
  expect(screen.queryByTestId("answer-form")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("question")));
  expect(api.requests).toContain("POST /v1/tasks/7/questions/1/answer");
});

test("poster_cancels_an_answer_and_the_focus_goes_back_to_its_button", async () => {
  fakeApi(board({ questions: [question("1")] }));
  await connectedAs(POSTER);
  await loaded();
  const user = userEvent.setup();

  await user.click(screen.getByRole("button", { name: "Answer" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));

  expect(screen.queryByTestId("answer-form")).toBeNull();
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Answer" })),
  );
});

test("poster_hides_a_question_after_saying_yes_and_only_the_asker_stays", async () => {
  const api = fakeApi(board({ questions: [question("1", { asker: "spam.testnet" })] }));
  await connectedAs(POSTER);
  await loaded();
  const user = userEvent.setup();

  await user.click(screen.getByRole("button", { name: "Hide" }));
  // The safe choice has the focus, and Keep leaves the question as it was.
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep" }));
  await user.click(screen.getByRole("button", { name: "Keep" }));
  expect(screen.getByTestId("question-text")).toBeTruthy();
  expect(api.requests.some((request) => request.endsWith("/hide"))).toBe(false);

  await user.click(screen.getByRole("button", { name: "Hide" }));
  await user.click(screen.getByRole("button", { name: "Yes, hide" }));

  const row = screen.getByTestId("question");
  await waitFor(() =>
    expect(within(row).getByTestId("question-hidden").textContent).toBe("hidden by the poster"),
  );
  expect(within(row).getByTestId("asker").textContent).toBe("spam.testnet");
  expect(within(row).queryByRole("button")).toBeNull();
  expect(api.requests).toContain("POST /v1/tasks/7/questions/1/hide");
});

test("poster_posts_a_clarification_under_the_same_limits", async () => {
  const api = fakeApi(board(), {
    clarify: (_, call) =>
      call === 2
        ? refusal(
            429,
            "rate_limited",
            "a poster may post 10 clarifications an hour on a task, and you have; try again later",
          )
        : undefined,
  });
  await connectedAs(POSTER);
  await loaded();
  const user = userEvent.setup();
  const field = screen.getByLabelText("Post a clarification");

  await user.type(field, "Amounts are in euros.");
  expect(screen.getByTestId("char-count").textContent).toBe("21 / 1,000");
  await user.click(screen.getByRole("button", { name: "Post" }));
  const posted = await screen.findByTestId("clarification");
  expect(within(posted).getByTestId("clarification-text").textContent).toBe(
    "Amounts are in euros.",
  );
  expect(api.requests).toContain("POST /v1/tasks/7/clarifications");

  await user.type(field, "And dates are UTC.");
  await user.click(screen.getByRole("button", { name: "Post" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "A task takes 10 clarifications an hour. Try again later.",
  );
});

test("poster_is_told_plainly_when_a_hide_is_refused", async () => {
  fakeApi(board({ questions: [question("1")] }), {
    hide: () => refusal(409, "not_open", "the board takes writes only while the task is open"),
  });
  await connectedAs(POSTER);
  await loaded();
  const user = userEvent.setup();

  await user.click(screen.getByRole("button", { name: "Hide" }));
  await user.click(screen.getByRole("button", { name: "Yes, hide" }));

  expect((await screen.findByRole("alert")).textContent).toBe(
    "The commit deadline has passed, so this board is read-only: no new questions, answers or clarifications.",
  );
  expect(screen.getByTestId("question-text")).toBeTruthy();
});

// ---- The wallet, the stream and failures -------------------------------------------------------

test("connect_looks_for_the_wallet_only_when_pressed_and_then_offers_the_form", async () => {
  fakeApi();
  const { provider } = wallet(ALICE);
  render(<Questions task={TASK} phase="open" refresh={0} />);
  await loaded();
  const user = userEvent.setup();

  await user.click(screen.getByRole("button", { name: "Connect wallet" }));

  expect(await screen.findByTestId("ask-form")).toBeTruthy();
  expect((provider as FakeProvider).connects).toBe(1);
});

test("a_tab_that_signed_in_before_looks_for_its_wallet_at_once", async () => {
  fakeApi();
  // What a sign-in in this tab left behind, for the poster.
  keepToken({ accountId: POSTER, token: "kept", expiresAtMs: Date.now() + 60_000 }, signInTicket());
  const { restore } = wallet(POSTER, { restored: true });
  render(<Questions task={TASK} phase="open" refresh={0} />);

  // The poster's own controls, with no press: the wallet from the earlier visit is back.
  expect(await screen.findByTestId("clarify-form")).toBeTruthy();
  expect(restore).toHaveBeenCalledTimes(1);
});

test("board_asks_again_when_the_stream_says_it_changed", async () => {
  const api = fakeApi();
  wallet(ALICE);
  const view = render(<Questions task={TASK} phase="open" refresh={0} />);
  await loaded();
  expect(api.requests).toEqual([`GET ${BOARD_PATH}`]);

  api.board = board({ questions: [question("1", { text: "Late question?" })] });
  // A burst of events is one read.
  view.rerender(<Questions task={TASK} phase="open" refresh={1} />);
  view.rerender(<Questions task={TASK} phase="open" refresh={2} />);

  expect((await screen.findByTestId("question-text")).textContent).toBe("Late question?");
  expect(api.requests).toEqual([`GET ${BOARD_PATH}`, `GET ${BOARD_PATH}`]);
});

test("board_says_when_it_cannot_be_read_and_retry_reads_it", async () => {
  let failing = true;
  fakeApi(board({ questions: [question("1")] }), {}, () =>
    failing ? json({ error: "internal", message: "db at 10.0.0.3" }, 500) : undefined,
  );
  wallet(ALICE);
  render(<Questions task={TASK} phase="open" refresh={0} />);

  const notice = await screen.findByTestId("board-error");
  expect(notice.textContent).toContain("500");
  expect(notice.textContent).not.toContain("10.0.0.3");
  // It is the section's own trouble: the page has no alert for it.
  expect(screen.queryByRole("alert")).toBeNull();
  expect(console.error).toHaveBeenCalled();

  failing = false;
  await userEvent.click(within(notice).getByRole("button", { name: "Retry" }));
  expect(await screen.findByTestId("question")).toBeTruthy();
  expect(screen.queryByTestId("board-error")).toBeNull();
});

test("board_from_an_api_without_one_says_so_and_logs_nothing", async () => {
  vi.stubGlobal("fetch", async () => json({ error: "not_found", message: "no such route" }, 404));
  wallet(ALICE);
  render(<Questions task={TASK} phase="open" refresh={0} />);

  expect((await screen.findByTestId("board-unavailable")).textContent).toBe(
    "Questions aren't available from this server.",
  );
  expect(console.error).not.toHaveBeenCalled();
});
