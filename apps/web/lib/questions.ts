import {
  ApiError,
  BOARD_LIMITS,
  BOARD_TEXT_MAX_CHARS,
  BoardTextSchema,
  ErrorBodySchema,
  type TaskDetail,
} from "@tender/shared";
import { walletErrorMessage } from "./walletErrors";

// The task page's question board (spec 7.2.1), apart from how it looks: who the person on the page
// is to the board, how long a text is as the API counts it, and the API's refusals in plain words.
// The API decides who may write; this only decides which controls to offer, and says what the API
// said when it turned a write away.

/** The fixed note the board carries on the page. The API's own note says the same at length. */
export const BOARD_NOTE_SHORT = "Answers explain the brief; they can't change the checks.";

/** Why the board takes no more writes: the task is past its open phase. */
export const BOARD_READ_ONLY =
  "The commit deadline has passed, so this board is read-only: no new questions, answers or clarifications.";

/** The most characters a text may have, as the page writes it. */
export const BOARD_MAX_LABEL = BOARD_TEXT_MAX_CHARS.toLocaleString("en-US");

/**
 * Who the connected account is to the board, by the task's own fields: the poster answers, hides and
 * clarifies; the verifier never asks; on a pinned task (`invited` not empty) only an invited
 * account asks; anyone else is an entrant, whom the API still checks (a registered agent, on an
 * open task). Null: no account is connected.
 */
export type BoardRole = "poster" | "verifier" | "not_invited" | "entrant";

export function boardRole(
  task: Pick<TaskDetail, "poster" | "verifier" | "invited">,
  account: string | null,
): BoardRole | null {
  if (account === null) return null;
  // A poster who judges their own task is the poster here: they answer, and cannot ask.
  if (account === task.poster) return "poster";
  if (account === task.verifier) return "verifier";
  if (task.invited.length > 0 && !task.invited.includes(account)) return "not_invited";
  return "entrant";
}

/** How many characters `text` has as the API counts them: code points, once its ends are trimmed. */
export function boardLength(text: string): number {
  return [...text.trim()].length;
}

/** The API's text rule (`BoardTextSchema`) in words, by the rule's own message. */
function textRuleWords(message: string): string {
  const invisible = /invisible formatting characters \(found (U\+[0-9A-F]{4,6})\)/.exec(message);
  if (invisible) {
    return `The text has an invisible character (${invisible[1]}). Delete it and try again.`;
  }
  if (/control characters/.test(message)) {
    return "The text has a control character. Delete it and try again.";
  }
  if (/well-formed/.test(message)) {
    return "The text has a broken character. Delete it and try again.";
  }
  if (/at most/.test(message)) return `The text is over ${BOARD_MAX_LABEL} characters.`;
  if (/some text/.test(message)) return "Write something first.";
  return message;
}

/**
 * What is wrong with `text` by the API's own rule, before it is sent, or null. An empty text is
 * not a problem to tell anyone about: the button just waits for one.
 */
export function boardTextProblem(text: string): string | null {
  if (text.trim() === "") return null;
  const parsed = BoardTextSchema.safeParse(text);
  if (parsed.success) return null;
  return textRuleWords(parsed.error.issues[0]?.message ?? "");
}

/** What the person pressed, for the words of a refusal. */
export type BoardAction = "ask" | "answer" | "hide" | "clarify";

/** The route limit's own message (`RateLimits.board`), as opposed to the hourly counts. */
const ROUTE_LIMIT = /^too many requests/;

/** Plain words for the API's refusals of a board write, by its error code. */
function refusalWords(code: string, message: string, action: BoardAction): string | undefined {
  switch (code) {
    case "rate_limited":
      if (ROUTE_LIMIT.test(message)) return "Too many at once. Wait a minute, then try again.";
      if (action === "ask") {
        return `An account can ask ${BOARD_LIMITS.askerPerTaskPerHour} questions an hour on a task. Try again later.`;
      }
      if (action === "clarify") {
        return `A task takes ${BOARD_LIMITS.clarificationsPerHour} clarifications an hour. Try again later.`;
      }
      return "Too many at once. Wait a minute, then try again.";
    case "question_limit":
      return `An account can ask ${BOARD_LIMITS.askerPerTask} questions on a task, and this one has.`;
    case "clarification_limit":
      return `A task takes ${BOARD_LIMITS.clarificationsPerTask} clarifications, and this one has them.`;
    case "board_full":
      return `This board is full: a task shows ${BOARD_LIMITS.questionsPerTask} questions.`;
    case "not_registered":
      // The API will hold this to active agents once agents have a bond (its TODO); the words
      // already say so, as the code stays the same.
      return "Only a registered, active agent can ask on an open task, and this account isn't one.";
    case "not_invited":
      return "This task is open to invited accounts only, and this account isn't one of them.";
    case "poster_cannot_ask":
      return "You posted this task, so you answer questions here rather than ask them.";
    case "verifier_cannot_ask":
      return "The verifier of a task can't ask questions on it.";
    case "not_poster":
      return "Only the poster can do that.";
    case "not_open":
      return BOARD_READ_ONLY;
    case "already_answered":
      return "That question has an answer already.";
    case "hidden":
      return "That question is hidden, so it can't be answered.";
    case "not_found":
      return "That question isn't on this board.";
    case "payload_too_large":
      return `The text is over ${BOARD_MAX_LABEL} characters.`;
    default:
      return undefined;
  }
}

/**
 * Plain words for why a board write failed: the API's refusal by its code, the text rule by its
 * message, a sign-in or wallet step by `walletErrorMessage`, and anything else as `errorMessage`
 * says it. The API's words are a last resort: they are for a developer more than for a reader.
 */
export function boardFailure(error: unknown, action: BoardAction): string {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    const body = ErrorBodySchema.safeParse(error.body);
    if (body.success) {
      const { error: code, message, issues } = body.data;
      if (code === "bad_request") {
        const issue = issues?.find((one) => one.path.includes("text")) ?? issues?.[0];
        if (issue !== undefined) return textRuleWords(issue.message);
      }
      const words = refusalWords(code, message, action);
      if (words !== undefined) return words;
    }
  }
  return walletErrorMessage(error);
}
