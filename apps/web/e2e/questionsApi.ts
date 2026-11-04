import type { Page, Route } from "@playwright/test";
import {
  type ChallengeResponse,
  type Clarification,
  canonicalBase,
  type Question,
  SIGN_IN_MESSAGE,
  type TaskBoard,
} from "@tender/shared";
import { API_URL, emptyBoard, type FixtureApi } from "./fixtures";

// The writes of the question board (spec 7.2.1) for the specs of the task page, over the boards of
// the fixture API (e2e/fixtures.ts): the sign-in that gives the token, and ask, answer, hide and
// clarify, each for a request that carries it. A write changes the fixture's board and tells the
// stream, as the API does. A spec can have the API turn a write away (`refuse`), with the API's
// own error body. Register it after `routeApi`, which it falls back to for everything else.

const CORS = { "access-control-allow-origin": "*" };
const PREFLIGHT = {
  ...CORS,
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const TOKEN = "e2e-board-token";
/** 32 bytes, as the API's nonce is. */
const NONCE = Buffer.alloc(32, 7).toString("base64");

export type BoardWrite = "ask" | "answer" | "hide" | "clarify";

/** What the API answers instead of taking a write: a status and its error body. */
export interface Refusal {
  status: number;
  error: string;
  message: string;
  issues?: unknown[];
}

export interface BoardWrites {
  /** `METHOD /path` of each request this answered, in order. */
  requests: string[];
  /** The text of each write that was taken, in order. */
  texts: string[];
  /** The next write of `kind` is turned away with `refusal`, once. */
  refuse(kind: BoardWrite, refusal: Refusal): void;
}

/**
 * Answers the sign-in and the board's writes on `page` for `account`, over `api`'s boards. The time
 * a write is stamped with is the page's clock's, which a spec sets.
 */
export async function routeBoardWrites(
  page: Page,
  api: FixtureApi,
  account: string,
): Promise<BoardWrites> {
  const refusals = new Map<BoardWrite, Refusal>();
  const writes: BoardWrites = {
    requests: [],
    texts: [],
    refuse: (kind, refusal) => void refusals.set(kind, refusal),
  };
  let nextId = 100;

  const boardOf = (taskId: string): TaskBoard => api.boards.get(taskId) ?? emptyBoard(taskId);
  const at = () => new Date().toISOString();

  async function answer(route: Route): Promise<void> {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: PREFLIGHT });
    if (request.method() !== "POST") return route.fallback();
    const { pathname } = new URL(request.url());
    writes.requests.push(`POST ${pathname}`);
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, json: body, headers: CORS });

    if (pathname === "/v1/auth/challenge") {
      const body: ChallengeResponse = {
        nonce: NONCE,
        message: SIGN_IN_MESSAGE,
        recipient: canonicalBase(API_URL),
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      };
      return json(200, body);
    }
    if (pathname === "/v1/auth/verify") {
      const body = request.postDataJSON() as Record<string, unknown>;
      if (body.account_id !== account || body.nonce !== NONCE) {
        return json(401, { error: "unauthorized", message: "That sign-in is not valid." });
      }
      return json(200, {
        token: TOKEN,
        expires_at: "2099-01-01T00:00:00.000Z",
        key_kind: "full_access",
      });
    }

    if (request.headers().authorization !== `Bearer ${TOKEN}`) {
      return json(401, { error: "unauthorized", message: "Sign in first." });
    }
    const route_ =
      /^\/v1\/tasks\/(\d+)\/(?:questions(?:\/(\d+)\/(answer|hide))?|(clarifications))$/.exec(
        pathname,
      );
    if (route_ === null) return json(404, { error: "not_found", message: "no such route" });
    const [, taskId = "", questionId, verb, clarifications] = route_;
    const kind: BoardWrite = clarifications ? "clarify" : verb ? (verb as BoardWrite) : "ask";
    const refused = refusals.get(kind);
    if (refused !== undefined) {
      refusals.delete(kind);
      const { status, ...body } = refused;
      return json(status, body);
    }
    const text =
      kind === "hide"
        ? ""
        : String((request.postDataJSON() as { text?: unknown }).text ?? "").trim();
    if (kind !== "hide") writes.texts.push(text);
    const board = boardOf(taskId);

    if (kind === "ask") {
      const question: Question = {
        id: String(nextId++),
        asker: account,
        text,
        asked_at: at(),
        hidden: false,
        answer: null,
      };
      api.boards.set(taskId, { ...board, questions: [...board.questions, question] });
      api.boardEvent({
        event: "question_asked",
        data: { task_id: taskId, question_id: question.id, asker: account },
      });
      return json(200, { question });
    }
    if (kind === "clarify") {
      const clarification: Clarification = { id: String(nextId++), text, posted_at: at() };
      api.boards.set(taskId, {
        ...board,
        clarifications: [...board.clarifications, clarification],
      });
      api.boardEvent({
        event: "clarification_posted",
        data: { task_id: taskId, clarification_id: clarification.id },
      });
      return json(200, { clarification });
    }
    const found = board.questions.find((one) => one.id === questionId);
    if (found === undefined) return json(404, { error: "not_found", message: "no such question" });
    const changed: Question =
      kind === "hide"
        ? { ...found, hidden: true, text: null, answer: null }
        : { ...found, answer: { text, answered_at: at() } };
    api.boards.set(taskId, {
      ...board,
      questions: board.questions.map((one) => (one.id === found.id ? changed : one)),
    });
    api.boardEvent(
      kind === "hide"
        ? { event: "question_hidden", data: { task_id: taskId, question_id: found.id } }
        : { event: "question_answered", data: { task_id: taskId, question_id: found.id } },
    );
    return json(200, { question: changed });
  }

  await page.route(`${API_URL}/v1/auth/**`, answer);
  await page.route(`${API_URL}/v1/tasks/*/questions`, answer);
  await page.route(`${API_URL}/v1/tasks/*/questions/*/*`, answer);
  await page.route(`${API_URL}/v1/tasks/*/clarifications`, answer);
  return writes;
}
