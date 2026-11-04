"use client";

import {
  ApiError,
  BOARD_HIDDEN_LABEL,
  BOARD_TEXT_MAX_CHARS,
  type Clarification,
  type Phase,
  type Question,
  type TaskBoard,
  type TaskDetail,
} from "@tender/shared";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { api } from "../lib/api";
import { heldToken, noToken, subscribeToken } from "../lib/apiToken";
import { useApiToken } from "../lib/auth";
import { errorMessage } from "../lib/errors";
import {
  BOARD_MAX_LABEL,
  BOARD_NOTE_SHORT,
  BOARD_READ_ONLY,
  type BoardAction,
  type BoardRole,
  boardFailure,
  boardLength,
  boardRole,
  boardTextProblem,
} from "../lib/questions";
import { type Told, toldFor } from "../lib/told";
import { useWallet } from "../lib/wallet";
import { WALLET_CANNOT_SIGN_MESSAGE, walletErrorMessage } from "../lib/walletErrors";
import { Avatar } from "./Avatar";
import { FACT_LABEL, FIELD, NOTICE, PANEL, PANEL_TITLE, PRIMARY, SECONDARY } from "./ui";

// The task's public question board (spec 7.2.1): every question with its asker, its time and its
// answer, the poster's clarifications, and the fixed note that none of it changes the checks. An
// entrant asks; the poster answers, hides and clarifies; after the commit deadline it is read-only.
//
// Everything on it is a stranger's words, so it is shown as plain text and nothing else: React
// writes it as text (no HTML), nothing reads it as markdown, and nothing turns an address in it into
// a link. Line breaks are kept, as the writer typed them.
//
// The wallet is not looked for to read the board. The store starts when someone presses Connect, or
// at once if this tab signed in to Tender before (it holds a token), so a reader of a task loads no
// wallet library, and a poster who has just posted sees their controls without a press.

/** How long the board waits for the stream to go quiet before it asks again, as the task does. */
const EVENTS_QUIET_MS = 300;

type Load =
  | { status: "loading" }
  /** The API has no board for the task: an API from before the board. */
  | { status: "unavailable" }
  | { status: "error"; message: string; retrying: boolean }
  | { status: "ready"; board: TaskBoard; stale: { message: string; retrying: boolean } | null };

/** When `iso` was, in the reader's own zone: a day and a time of day. */
function when(iso: string): string {
  return new Date(iso).toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** `count` of `one`, with an s for more than one. */
const counted = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/** The board with `question` in it: replaced where it was, or added at the end. */
function withQuestion(board: TaskBoard, question: Question): TaskBoard {
  const at = board.questions.findIndex((one) => one.id === question.id);
  const questions =
    at === -1
      ? [...board.questions, question]
      : board.questions.map((one, i) => (i === at ? question : one));
  return { ...board, questions };
}

function withClarification(board: TaskBoard, clarification: Clarification): TaskBoard {
  if (board.clarifications.some((one) => one.id === clarification.id)) return board;
  return { ...board, clarifications: [...board.clarifications, clarification] };
}

/** A stranger's words, as text. */
function Words({ text, testId }: { text: string; testId: string }) {
  return (
    <p
      data-testid={testId}
      className="text-[15px] leading-relaxed whitespace-pre-wrap text-bone wrap-anywhere"
    >
      {text}
    </p>
  );
}

/** Who wrote it and when, on one line. */
function Byline({ account, at, label }: { account: string | null; at: string; label?: string }) {
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
      {account === null ? null : (
        // The avatar stays beside the account, which breaks where it has to (an implicit account
        // is 64 characters with nowhere to break).
        <span className="flex max-w-full min-w-0 items-center gap-2.5">
          <Avatar account={account} size={22} />
          <span
            data-testid="asker"
            className="min-w-0 font-mono text-[13px] text-bone wrap-anywhere"
          >
            {account}
          </span>
        </span>
      )}
      {label === undefined ? null : <span className={FACT_LABEL}>{label}</span>}
      <time dateTime={at} className="font-mono text-xs text-muted">
        {when(at)}
      </time>
    </p>
  );
}

/** A failure the person caused by pressing something: said at once. */
function Failure({ message }: { message: string }) {
  return (
    <p
      role="alert"
      data-testid="board-failure"
      className="rounded-xl border border-seal/45 bg-seal/[0.06] p-3.5 text-sm text-bone"
    >
      {message}
    </p>
  );
}

/**
 * A text field for the board: its label, the live count against the limit, the text rule, and the
 * button. It does not cut the text at the limit (a paste that is too long stays, to be shortened);
 * the button waits until the text is something the API takes.
 */
function TextForm({
  testId,
  label,
  placeholder,
  submit,
  running,
  failure,
  onSubmit,
  onCancel,
  autoFocus = false,
}: {
  testId: string;
  label: string;
  placeholder?: string;
  submit: { idle: string; running: string };
  running: boolean;
  failure: string | null;
  /** Sends the text; true if it was taken, and the field is emptied. */
  onSubmit: (text: string) => Promise<boolean>;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const length = boardLength(text);
  const over = length > BOARD_TEXT_MAX_CHARS;
  const problem = boardTextProblem(text);
  const ready = length > 0 && problem === null && !running;

  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    if (await onSubmit(text)) setText("");
  };

  return (
    <form data-testid={testId} onSubmit={send} className="grid gap-2.5" noValidate>
      <label htmlFor={id} className={FACT_LABEL}>
        {label}
      </label>
      <textarea
        id={id}
        ref={field}
        value={text}
        rows={3}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        aria-invalid={problem !== null}
        aria-describedby={`${id}-count ${id}-rule`}
        className={`${FIELD} min-h-24 resize-y py-2.5 text-[15px] leading-relaxed`}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p
          id={`${id}-count`}
          data-testid="char-count"
          className={`font-mono text-xs tabular-nums ${over ? "text-seal" : "text-muted"}`}
        >
          {`${length.toLocaleString("en-US")} / ${BOARD_MAX_LABEL}`}
        </p>
        <span className="flex flex-wrap gap-2">
          {onCancel === undefined ? null : (
            <button type="button" onClick={onCancel} className={SECONDARY}>
              Cancel
            </button>
          )}
          {/* `aria-disabled` and not `disabled`, so that the button keeps the focus while it sends. */}
          <button type="submit" aria-disabled={!ready} className={PRIMARY}>
            {running ? submit.running : submit.idle}
          </button>
        </span>
      </div>
      {/* Said as it changes: a text that goes over the limit, or holds a character the API refuses. */}
      <p id={`${id}-rule`} aria-live="polite" className="text-sm text-seal empty:hidden">
        {problem ?? ""}
      </p>
      {failure === null ? null : <Failure message={failure} />}
    </form>
  );
}

/** One question: who asked and when, the text (or that it is hidden), the answer, and the poster's controls. */
function QuestionItem({
  question,
  hiddenLabel,
  controls,
  itemRef,
}: {
  question: Question;
  hiddenLabel: string;
  controls: ReactNode;
  itemRef: (item: HTMLLIElement | null) => void;
}) {
  return (
    <li
      ref={itemRef}
      data-testid="question"
      data-question-id={question.id}
      data-hidden={question.hidden}
      tabIndex={-1}
      className="grid gap-2.5 border-t border-line py-4 first:border-t-0 first:pt-0 last:pb-0"
    >
      <Byline account={question.asker} at={question.asked_at} />
      {question.hidden || question.text === null ? (
        <p data-testid="question-hidden" className="text-sm text-muted italic">
          {hiddenLabel}
        </p>
      ) : (
        <Words text={question.text} testId="question-text" />
      )}
      {/* A hidden question shows its label and its asker, and nothing it said or was told, even
          from a server that sent its words along. */}
      {question.hidden ? null : question.answer === null ? (
        <p data-testid="question-unanswered" className="font-mono text-xs text-muted">
          Not answered yet
        </p>
      ) : (
        <div data-testid="question-answer" className="grid gap-1.5 rounded-xl bg-raised p-4">
          <Byline account={null} at={question.answer.answered_at} label="Poster's answer" />
          <Words text={question.answer.text} testId="answer-text" />
        </div>
      )}
      {controls}
    </li>
  );
}

/** What a poster's press on one question is doing. */
type PosterStep = { id: string; step: "answering" | "confirm-hide" } | null;

/**
 * The question board of `task`. `phase` is the task's phase by the clock; `refresh` goes up when
 * the event stream says the board changed (or opened with nothing to resume from), and the board
 * asks again a moment later.
 */
export function Questions({
  task,
  phase,
  refresh,
}: {
  task: Pick<TaskDetail, "id" | "poster" | "verifier" | "invited">;
  phase: Phase;
  refresh: number;
}) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const latest = useRef(0);
  const headingId = useId();

  const fetchBoard = useCallback(
    (quiet: boolean) => {
      const request = ++latest.current;
      setLoad((was) => {
        if (was.status === "error") return { ...was, retrying: true };
        if (was.status === "ready" && was.stale !== null) {
          return { ...was, stale: { ...was.stale, retrying: true } };
        }
        return quiet ? was : { status: "loading" };
      });
      api.getQuestions(task.id).then(
        (board) => {
          if (request !== latest.current) return;
          setLoad(
            board === null ? { status: "unavailable" } : { status: "ready", board, stale: null },
          );
        },
        (error) => {
          if (request !== latest.current) return;
          // The person gets words; the original goes to the console, where a developer looks.
          console.error(error);
          const message = errorMessage(error);
          setLoad((was) =>
            was.status === "ready"
              ? { ...was, stale: { message, retrying: false } }
              : { status: "error", message, retrying: false },
          );
        },
      );
    },
    [task.id],
  );

  useEffect(() => {
    fetchBoard(false);
  }, [fetchBoard]);

  // The stream said the board changed. A burst of events is one read, a moment after the last.
  useEffect(() => {
    if (refresh === 0) return;
    const timer = setTimeout(() => fetchBoard(true), EVENTS_QUIET_MS);
    return () => clearTimeout(timer);
  }, [refresh, fetchBoard]);

  /** A write came back: the page shows it at once, and reads the board again to be sure. */
  const took = useCallback(
    (change: (board: TaskBoard) => TaskBoard) => {
      setLoad((was) => (was.status === "ready" ? { ...was, board: change(was.board) } : was));
      fetchBoard(true);
    },
    [fetchBoard],
  );

  const board = load.status === "ready" ? load.board : null;
  const writable = phase === "open" && (board?.open ?? false);
  const questions = board?.questions.length ?? 0;
  const clarifications = board?.clarifications.length ?? 0;

  return (
    <section data-testid="questions" aria-labelledby={headingId} className={PANEL}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={headingId} className={PANEL_TITLE}>
          Questions
        </h2>
        {questions + clarifications === 0 ? null : (
          <p data-testid="board-summary" className="font-mono text-xs text-muted">
            {clarifications === 0
              ? counted(questions, "question")
              : `${counted(questions, "question")} · ${counted(clarifications, "clarification")}`}
          </p>
        )}
      </div>
      <p data-testid="board-note" className="flex gap-2.5 text-sm text-muted">
        <span aria-hidden="true" className="mt-[0.45rem] size-1.5 shrink-0 rounded-full bg-seal" />
        {BOARD_NOTE_SHORT}
      </p>

      {load.status === "loading" ? (
        <p aria-busy="true" className="text-sm text-muted">
          Loading questions…
        </p>
      ) : load.status === "unavailable" ? (
        <p data-testid="board-unavailable" className="text-sm text-muted">
          Questions aren't available from this server.
        </p>
      ) : load.status === "error" ? (
        <Unread message={load.message} retrying={load.retrying} onRetry={() => fetchBoard(false)} />
      ) : (
        <>
          {load.stale === null ? null : (
            <Unread
              message={`${load.stale.message} The questions may be out of date.`}
              retrying={load.stale.retrying}
              onRetry={() => fetchBoard(true)}
            />
          )}
          <BoardBody task={task} board={load.board} writable={writable} onTook={took} />
        </>
      )}
    </section>
  );
}

/** The board could not be read: the words, and a way to try again. It is the section's alone. */
function Unread({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      data-testid="board-error"
      className={`${NOTICE} flex flex-wrap items-center justify-between gap-3`}
    >
      <p className="min-w-0 wrap-anywhere">{message}</p>
      <button
        type="button"
        aria-disabled={retrying}
        onClick={retrying ? undefined : onRetry}
        className={SECONDARY}
      >
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}

/** The board's rows, and what the person on the page may do with them. */
function BoardBody({
  task,
  board,
  writable,
  onTook,
}: {
  task: Pick<TaskDetail, "id" | "poster" | "verifier" | "invited">;
  board: TaskBoard;
  writable: boolean;
  onTook: (change: (board: TaskBoard) => TaskBoard) => void;
}) {
  // The wallet as far as this tab knows it. It is looked for only if the tab signed in before.
  const stored = useSyncExternalStore(subscribeToken, heldToken, noToken);
  const startWallet = stored !== null;
  const wallet = useWallet({ start: startWallet });
  const { token, signIn } = useApiToken({ start: startWallet });
  const account = wallet.accountId;
  const role: BoardRole | null = boardRole(task, account);

  const [running, setRunning] = useState<string | null>(null);
  const [failure, setFailure] = useState<Told<{ where: string; message: string }> | null>(null);
  const [said, setSaid] = useState<Told<string> | null>(null);
  const [step, setStep] = useState<PosterStep>(null);
  const busy = useRef(false);
  const items = useRef(new Map<string, HTMLLIElement>());
  const answerButtons = useRef(new Map<string, HTMLButtonElement>());
  // Where the focus goes once the list shows what a press did: the question it was about (its
  // answer form or its text is gone), or back to its Answer button after a Cancel. A focused
  // control that goes away leaves the keyboard at the top of the page.
  const [focusOn, setFocusOn] = useState<{ id: string; on: "item" | "answer" } | null>(null);
  useEffect(() => {
    if (focusOn === null) return;
    const target =
      focusOn.on === "item" ? items.current.get(focusOn.id) : answerButtons.current.get(focusOn.id);
    target?.focus();
    setFocusOn(null);
  }, [focusOn]);

  const failed = toldFor(failure, account);
  const failedAt = (where: string) => (failed?.where === where ? failed.message : null);
  const told = toldFor(said, account);

  /** A board write with the token: the hook's, or one a sign-in gives; once more after a 401. */
  async function signedIn<T>(call: (token: string) => Promise<T>): Promise<T> {
    const first = token ?? (await signIn());
    try {
      return await call(first);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    }
    return call(await signIn());
  }

  /** Runs one write, named `where` for its failure, and says how it went. */
  async function write<T>(
    where: string,
    action: BoardAction,
    call: (token: string) => Promise<T>,
    done: (result: T) => void,
  ): Promise<boolean> {
    if (busy.current || account === null) return false;
    busy.current = true;
    setRunning(where);
    setFailure(null);
    setSaid(null);
    const asker = account;
    try {
      const result = await signedIn(call);
      done(result);
      return true;
    } catch (error) {
      console.error(error);
      setFailure({ account: asker, value: { where, message: boardFailure(error, action) } });
      return false;
    } finally {
      busy.current = false;
      setRunning(null);
    }
  }

  const focusItem = (id: string) => setFocusOn({ id, on: "item" });

  const ask = (text: string) =>
    write(
      "ask",
      "ask",
      (bearer) => api.askQuestion(bearer, task.id, text),
      ({ question }) => {
        onTook((was) => withQuestion(was, question));
        setSaid({ account, value: "Your question is on the board." });
      },
    );

  const clarify = (text: string) =>
    write(
      "clarify",
      "clarify",
      (bearer) => api.postClarification(bearer, task.id, text),
      ({ clarification }) => {
        onTook((was) => withClarification(was, clarification));
        setSaid({ account, value: "Your clarification is on the board." });
      },
    );

  const answer = (id: string) => (text: string) =>
    write(
      `answer:${id}`,
      "answer",
      (bearer) => api.answerQuestion(bearer, task.id, id, text),
      ({ question }) => {
        onTook((was) => withQuestion(was, question));
        setStep(null);
        focusItem(id);
      },
    );

  const hide = (id: string) =>
    void write(
      `hide:${id}`,
      "hide",
      (bearer) => api.hideQuestion(bearer, task.id, id),
      ({ question }) => {
        onTook((was) => withQuestion(was, question));
        setStep(null);
        focusItem(id);
      },
    );

  const [connecting, setConnecting] = useState(false);
  const [connectFailure, setConnectFailure] = useState<string | null>(null);
  const connect = async () => {
    if (connecting) return;
    setConnecting(true);
    setConnectFailure(null);
    try {
      await wallet.connect();
    } catch (error) {
      console.error(error);
      setConnectFailure(walletErrorMessage(error));
    } finally {
      setConnecting(false);
    }
  };

  const poster = writable && role === "poster" && wallet.canSignMessage;

  /** The poster's controls on one question, while the board takes writes. */
  function controlsOf(question: Question): ReactNode {
    if (!poster || question.hidden) return null;
    const where = step?.id === question.id ? step.step : null;
    const answerFailure = failedAt(`answer:${question.id}`);
    const hideFailure = failedAt(`hide:${question.id}`);
    if (where === "answering") {
      return (
        <div className="rounded-xl border border-line p-4">
          <TextForm
            testId="answer-form"
            label="Your answer"
            submit={{ idle: "Post answer", running: "Posting…" }}
            running={running === `answer:${question.id}`}
            failure={answerFailure}
            onSubmit={answer(question.id)}
            onCancel={() => {
              setStep(null);
              setFocusOn({ id: question.id, on: "answer" });
            }}
            autoFocus
          />
        </div>
      );
    }
    if (where === "confirm-hide") {
      return (
        <div
          data-testid="hide-confirm"
          className={`${NOTICE} flex flex-wrap items-center justify-between gap-3`}
        >
          <p>Hide it for everyone? The asker stays shown. It can't be undone.</p>
          <span className="flex flex-wrap gap-2">
            <KeepButton onKeep={() => setStep(null)} />
            <button
              type="button"
              aria-disabled={running !== null}
              onClick={running !== null ? undefined : () => hide(question.id)}
              className={PRIMARY}
            >
              {running === `hide:${question.id}` ? "Hiding…" : "Yes, hide"}
            </button>
          </span>
          {hideFailure === null ? null : (
            <div className="basis-full">
              <Failure message={hideFailure} />
            </div>
          )}
        </div>
      );
    }
    return (
      <span className="flex flex-wrap gap-2">
        {question.answer === null ? (
          <button
            type="button"
            ref={(button) => {
              if (button === null) answerButtons.current.delete(question.id);
              else answerButtons.current.set(question.id, button);
            }}
            onClick={() => setStep({ id: question.id, step: "answering" })}
            className={SECONDARY}
          >
            Answer
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setStep({ id: question.id, step: "confirm-hide" })}
          className={SECONDARY}
        >
          Hide
        </button>
      </span>
    );
  }

  return (
    <>
      {board.clarifications.length === 0 ? null : (
        <ul aria-label="Clarifications from the poster" className="grid gap-3">
          {board.clarifications.map((clarification) => (
            <li
              key={clarification.id}
              data-testid="clarification"
              className="grid gap-1.5 rounded-xl border border-line bg-raised p-4"
            >
              <Byline account={null} at={clarification.posted_at} label="Clarification" />
              <Words text={clarification.text} testId="clarification-text" />
            </li>
          ))}
        </ul>
      )}

      {board.questions.length === 0 ? (
        <p data-testid="board-empty" className="text-sm text-muted">
          No questions yet.
        </p>
      ) : (
        <ul aria-label="Questions" className="grid">
          {board.questions.map((question) => (
            <QuestionItem
              key={question.id}
              question={question}
              hiddenLabel={board.hidden_label || BOARD_HIDDEN_LABEL}
              controls={controlsOf(question)}
              itemRef={(item) => {
                if (item === null) items.current.delete(question.id);
                else items.current.set(question.id, item);
              }}
            />
          ))}
        </ul>
      )}

      <div className="grid gap-3 border-t border-line pt-4">
        {!writable ? (
          <p data-testid="board-read-only" className={NOTICE}>
            {BOARD_READ_ONLY}
          </p>
        ) : account === null ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">Connect a wallet to ask or answer.</p>
            <button
              type="button"
              aria-disabled={connecting}
              onClick={connecting ? undefined : connect}
              className={SECONDARY}
            >
              {connecting ? "Waiting for your wallet…" : "Connect wallet"}
            </button>
            {connectFailure === null ? null : (
              <div className="basis-full">
                <Failure message={connectFailure} />
              </div>
            )}
          </div>
        ) : !wallet.canSignMessage ? (
          <p data-testid="cannot-sign" className={NOTICE}>
            {WALLET_CANNOT_SIGN_MESSAGE}
          </p>
        ) : role === "poster" ? (
          <TextForm
            testId="clarify-form"
            label="Post a clarification"
            placeholder="Something every entrant should know about the brief."
            submit={{ idle: "Post", running: "Posting…" }}
            running={running === "clarify"}
            failure={failedAt("clarify")}
            onSubmit={clarify}
          />
        ) : role === "verifier" ? (
          <p data-testid="board-role" className="text-sm text-muted">
            You verify this task, so you don't ask questions on it.
          </p>
        ) : role === "not_invited" ? (
          <p data-testid="board-role" className="text-sm text-muted">
            Only the accounts this task invited can ask questions.
          </p>
        ) : (
          <TextForm
            testId="ask-form"
            label="Ask the poster"
            placeholder="A question about the brief. Everyone can read it."
            submit={{ idle: "Ask", running: "Asking…" }}
            running={running === "ask"}
            failure={failedAt("ask")}
            onSubmit={ask}
          />
        )}
        {told === null ? null : (
          <p role="status" data-testid="board-said" className="text-sm text-muted">
            {told}
          </p>
        )}
      </div>
    </>
  );
}

/** "Keep", the safe choice of the hide prompt, which takes the focus when the prompt opens. */
function KeepButton({ onKeep }: { onKeep: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    button.current?.focus();
  }, []);
  return (
    <button type="button" ref={button} onClick={onKeep} className={SECONDARY}>
      Keep
    </button>
  );
}
