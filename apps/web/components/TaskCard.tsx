import type { Phase, TaskSummary } from "@tender/shared";
import Link from "next/link";
import { deadlineLine } from "../lib/card";
import { UNTITLED_TASK } from "../lib/copy";
import { isJudgeAccount } from "../lib/judge";
import { phaseOfTask } from "../lib/phase";
import { usePrefetchOnIntent } from "../lib/prefetch";
import { knowsToken } from "../lib/tokens";
import { Amount, RawUnits } from "./Amount";
import { ArrowIcon } from "./Arrow";
import { Avatar } from "./Avatar";
import { JudgeNote } from "./JudgeNote";
import { PhaseChip } from "./PhaseChip";
import { PosterJudges } from "./PosterJudges";
import { TeamLabel } from "./TeamBadge";
import { ICON_ROUND, TAG } from "./ui";

/** A card shows this many of a task's tags; the task's page has them all. */
const CARD_TAGS = 2;

/** Who checks the work, in a few words: the Judge, the poster, or the verifier's account. */
function checkedBy(task: TaskSummary, judgeAccount: string | null): string {
  if (isJudgeAccount(task.verifier, judgeAccount)) return "Judge checks";
  if (task.verifier === task.poster) return "Poster checks";
  return `Checked by ${task.verifier}`;
}

/**
 * How many agents are in, in a line: what the API counts, and nothing it does not. The agents that
 * said they started work are counted only while entries can still come (they are unverified).
 */
function countsLine(task: TaskSummary, phase: Phase): string {
  const parts: string[] = [];
  if (task.commit_count === 0) parts.push("No entries yet");
  else parts.push(`${task.commit_count} ${task.commit_count === 1 ? "agent" : "agents"} entered`);
  if (task.reveal_count > 0) parts.push(`${task.reveal_count} revealed`);
  if (phase === "open" && task.working_count > 0) parts.push(`${task.working_count} working`);
  return parts.join(" · ");
}

/**
 * A task on the board, as one of the board's rounded cards: its phase and reward at the top, its
 * title, how many agents are in, a tag or two, and at its foot who posted it, when its window
 * closes, who checks the work, and the round arrow that is the link to its page (it stretches over
 * the card, so that a click anywhere on it opens the task). The phase is worked out from the
 * task's deadlines at `nowNs`, as the task's own page works it out, and not the one the API gave
 * when the board loaded: a card and its page agree.
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
  const title = task.title ?? UNTITLED_TASK;
  const tags = task.tags.slice(0, CARD_TAGS);
  const phase = phaseOfTask(task, nowNs);
  return (
    <li
      {...intent}
      data-testid="task-card"
      data-featured={featured}
      className={`group relative flex min-w-0 flex-col rounded-2xl border p-6 transition-colors motion-reduce:transition-none sm:p-7 ${
        featured
          ? "on-paper border-transparent bg-paper text-ink"
          : "border-line bg-panel text-bone hover:border-bone/30 has-[a:focus-visible]:border-bone/50"
      }`}
    >
      <div className="flex items-center gap-3">
        <PhaseChip phase={phase} />
        {known ? (
          <span className="ml-auto min-w-0 text-right text-xl leading-tight font-medium tracking-[-0.02em] whitespace-nowrap tabular-nums">
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

      {featured ? (
        <p className={`mt-6 text-[11px] font-medium tracking-[0.14em] uppercase ${soft}`}>
          Top reward
        </p>
      ) : null}
      <h2
        className={`${featured ? "mt-2" : "mt-6"} line-clamp-2 text-xl leading-snug font-medium tracking-[-0.02em] wrap-anywhere`}
      >
        {title}
      </h2>
      <p data-testid="task-counts" className={`mt-2 text-[14px] leading-snug ${soft}`}>
        {countsLine(task, phase)}
      </p>
      {/* What the Judge made of the task: agents choose by it. */}
      <div className={`mt-1 text-[13px] leading-snug ${soft} empty:hidden`}>
        <JudgeNote status={task.judge_status} reason={task.judge_reason} />
      </div>
      {/* A poster who judges their own task is theirs to weigh before they enter. */}
      {task.verifier === task.poster ? (
        <div className={`mt-3 text-[13px] ${soft}`}>
          <PosterJudges />
        </div>
      ) : null}

      {tags.length === 0 ? null : (
        <ul
          className={`mt-4 flex min-w-0 flex-wrap gap-1.5 ${featured ? "text-ink" : "text-bone/85"}`}
          aria-label="Tags"
        >
          {tags.map((tag, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a brief may repeat a tag, so the place is part of the key
            <li key={`${tag}-${i}`} className="min-w-0">
              <span className={`${TAG} max-w-full truncate`}>{tag}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-auto flex items-center gap-3 pt-7">
        <Avatar account={task.poster} size={40} />
        <div className="grid min-w-0 flex-1 grid-cols-1 gap-1">
          {/* When the window closes, and who checks the work. On a narrow card the two parts are
              two lines, each whole. */}
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-1 text-[14px] leading-snug">
            <span className="whitespace-nowrap">
              {deadlineLine(task, nowNs, true)}
              <span className={soft}> ·</span>
            </span>
            <span className={`max-w-full min-w-0 truncate ${soft}`}>
              {checkedBy(task, judgeAccount)}
            </span>
          </p>
          {/* Who posted it. The team's own is labelled as ours, which is what a reader needs here:
              its account is in the label's title and is read out. */}
          <p
            data-testid="poster"
            title={task.poster}
            className={`flex min-w-0 items-center text-[12px] ${soft}`}
          >
            <span className="sr-only">Posted by</span>
            {task.is_team_poster ? (
              <>
                <span className="sr-only">{task.poster}</span>
                <TeamLabel />
              </>
            ) : (
              <span className="min-w-0 truncate font-mono">{task.poster}</span>
            )}
          </p>
        </div>
        {/* The card's link: it stretches over the card, so that a click anywhere opens the task. */}
        <Link
          href={`/tasks/${task.id}`}
          aria-label={`Open task: ${title}`}
          className={`${ICON_ROUND} after:absolute after:inset-0 after:rounded-2xl after:content-['']`}
        >
          <ArrowIcon className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0" />
        </Link>
      </div>
    </li>
  );
}
