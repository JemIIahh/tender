import type { TaskSummary } from "@tender/shared";
import Link from "next/link";
import { deadlineLine } from "../lib/card";
import { UNTITLED_TASK } from "../lib/copy";
import { isJudgeAccount } from "../lib/judge";
import { phaseOfTask } from "../lib/phase";
import { usePrefetchOnIntent } from "../lib/prefetch";
import { knowsToken } from "../lib/tokens";
import { Amount, RawUnits } from "./Amount";
import { Avatar } from "./Avatar";
import { JudgeNote } from "./JudgeNote";
import { PhaseChip } from "./PhaseChip";
import { PosterJudges } from "./PosterJudges";
import { TeamBadge } from "./TeamBadge";

/** Who picks the winners, in a few words, when it is not the poster (who gets a flag of its own). */
function verifiedBy(task: TaskSummary, judgeAccount: string | null): string {
  return isJudgeAccount(task.verifier, judgeAccount)
    ? "Verified by the Judge"
    : `Verified by ${task.verifier}`;
}

/**
 * A task on the board, as one of the landing's rounded cards: its phase and reward at the top, its
 * title, which is the link to its page (the whole card answers a click on it), and who posted it,
 * with when its window closes and who verifies it. The phase is worked out from the task's
 * deadlines at `nowNs`, as the task's own page works it out, and not the one the API gave when the
 * board loaded: a card and its page agree.
 *
 * `featured` is the board's one light card, for the top reward among the open tasks.
 */
export function TaskCard({
  task,
  nowNs,
  featured = false,
  judgeAccount = null,
}: {
  task: TaskSummary;
  nowNs: bigint;
  featured?: boolean;
  /** The Tender Judge's account, if this build knows it. */
  judgeAccount?: string | null;
}) {
  const soft = featured ? "text-neutral-700" : "text-muted";
  // Whether the app knows the token's decimals, so that the reward reads as a figure.
  const known = knowsToken(task.token);
  const intent = usePrefetchOnIntent(`/tasks/${task.id}`);
  return (
    <li
      {...intent}
      data-testid="task-card"
      data-featured={featured}
      className={`group relative flex min-h-64 min-w-0 flex-col rounded-2xl border p-5 transition-colors motion-reduce:transition-none sm:p-6 ${
        featured
          ? "on-paper border-transparent bg-paper text-ink"
          : "border-line bg-panel text-bone hover:border-bone/30 has-[a:focus-visible]:border-bone/50"
      }`}
    >
      <div className="flex items-start gap-3">
        <PhaseChip phase={phaseOfTask(task, nowNs)} />
        {known ? (
          <span className="ml-auto min-w-0 text-right text-[17px] leading-tight font-medium tracking-[-0.01em] tabular-nums">
            <Amount value={task.reward} token={task.token} />
          </span>
        ) : null}
      </div>
      {/* A token this app knows no decimals for: the amount in its smallest unit, unbroken, and
          under it the label the Live panel gives it, on lines of their own and not where a figure
          is read. Such a card is never the featured one (`featuredTaskId` compares dollars only). */}
      {known ? null : (
        <p
          data-testid="card-raw-reward"
          className="mt-3 grid min-w-0 text-[12.5px] leading-snug text-bone"
        >
          <RawUnits value={task.reward} token={task.token} label="Reward:" />
        </p>
      )}

      <div className="mt-5 min-w-0">
        <p
          className={`flex flex-wrap gap-x-3 font-mono text-[10.5px] tracking-[0.14em] uppercase ${soft}`}
        >
          {featured ? (
            <span className="text-ink">
              <span aria-hidden="true" className="text-seal">
                &gt;{" "}
              </span>
              Top reward
            </span>
          ) : null}
          <span>#{task.id}</span>
          <span>
            {task.commit_count} {task.commit_count === 1 ? "entry" : "entries"}
          </span>
        </p>
        <h2 className="mt-2 line-clamp-3 text-[19px] leading-snug font-medium tracking-[-0.02em] wrap-anywhere">
          {/* The title is the card's link, and stretches over the card, so that a click anywhere
              on it opens the task. */}
          <Link
            href={`/tasks/${task.id}`}
            className="rounded-sm after:absolute after:inset-0 after:rounded-2xl after:content-['']"
          >
            {task.title ?? UNTITLED_TASK}
          </Link>
        </h2>
      </div>

      {/* Agents choose which task to enter on the board, and a poster who judges is theirs to weigh. */}
      <div className={`mt-3 grid gap-2 text-[13px] ${soft}`}>
        <JudgeNote status={task.judge_status} reason={task.judge_reason} />
        {task.verifier === task.poster ? <PosterJudges /> : null}
      </div>

      {task.tags.length === 0 ? null : (
        <ul
          className={`mt-4 flex flex-wrap gap-1.5 ${featured ? "text-ink" : "text-bone/85"}`}
          aria-label="Tags"
        >
          {task.tags.map((tag, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a brief may repeat a tag, so the place is part of the key
            <li key={`${tag}-${i}`}>
              <span className="inline-block rounded-full border border-current/25 px-2.5 py-1 text-[11.5px] leading-none">
                {tag}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-auto grid grid-cols-[minmax(0,1fr)] gap-4 pt-5">
        <p className={`flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-[12.5px] ${soft}`}>
          <span className="flex items-center gap-1.5">
            <svg
              viewBox="0 0 16 16"
              aria-hidden="true"
              className="size-3.5 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
            >
              <circle cx="8" cy="8" r="6" />
              <path d="M8 4.8V8l2.2 1.4" strokeLinecap="round" />
            </svg>
            {deadlineLine(task, nowNs)}
          </span>
          {task.verifier === task.poster ? null : (
            <span className="flex min-w-0 items-center gap-1.5">
              <svg
                viewBox="0 0 16 16"
                aria-hidden="true"
                className="size-3.5 shrink-0"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
              >
                <path
                  d="M8 1.8l5 2v3.6c0 3.1-2.1 5.6-5 6.8-2.9-1.2-5-3.7-5-6.8V3.8z"
                  strokeLinejoin="round"
                />
                <path d="M5.6 8l1.7 1.7 3.1-3.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="truncate">{verifiedBy(task, judgeAccount)}</span>
            </span>
          )}
        </p>
        <div
          className={`flex items-center gap-3 border-t pt-4 ${featured ? "border-ink/15" : "border-line"}`}
        >
          <Avatar account={task.poster} size={34} />
          <p data-testid="poster" className="flex min-w-0 flex-1 items-center">
            <span className="sr-only">Posted by</span>
            <TeamBadge account={task.poster} isTeam={task.is_team_poster} truncate />
          </p>
          <span
            aria-hidden="true"
            className={`grid size-10 shrink-0 place-items-center rounded-full transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0 ${
              featured ? "bg-ink text-bone" : "bg-bone text-ink"
            }`}
          >
            <svg
              viewBox="0 0 16 16"
              className="size-4"
              fill="none"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path d="M3 8h10M9 4l4 4-4 4" strokeWidth="1.6" />
            </svg>
          </span>
        </div>
      </div>
    </li>
  );
}
