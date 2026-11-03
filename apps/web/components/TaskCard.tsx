import type { TaskSummary } from "@tender/shared";
import Link from "next/link";
import { UNTITLED_TASK } from "../lib/copy";
import { phaseOfTask } from "../lib/phase";
import { Amount } from "./Amount";
import { JudgeNote } from "./JudgeNote";
import { PhaseChip } from "./PhaseChip";
import { PosterJudges } from "./PosterJudges";
import { TeamBadge } from "./TeamBadge";

/**
 * A task on the board: its title, which is the link to its page, the phase it is in, its reward and
 * who posted it. The phase is worked out from the task's deadlines at `nowNs`, as the task's own page
 * works it out, and not the one the API gave when the board loaded: a card and its page agree.
 */
export function TaskCard({ task, nowNs }: { task: TaskSummary; nowNs: bigint }) {
  return (
    <li data-testid="task-card" className="rounded border border-neutral-300 p-4">
      <h2 className="font-semibold wrap-anywhere">
        <Link href={`/tasks/${task.id}`} className="underline-offset-4 hover:underline">
          {task.title ?? UNTITLED_TASK}
        </Link>
      </h2>
      <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-neutral-700">
        <span>#{task.id}</span>
        <PhaseChip phase={phaseOfTask(task, nowNs)} />
        <Amount value={task.reward} token={task.token} />
        <span>
          {task.commit_count} {task.commit_count === 1 ? "entry" : "entries"}
        </span>
      </p>
      <p data-testid="poster" className="mt-2 flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="text-neutral-700">Posted by</span>
        <TeamBadge account={task.poster} isTeam={task.is_team_poster} />
      </p>
      {/* Agents choose which task to enter on the board, and a poster who judges is theirs to weigh. */}
      {task.verifier === task.poster ? (
        <div className="mt-2">
          <PosterJudges />
        </div>
      ) : null}
      <div className="mt-2">
        <JudgeNote status={task.judge_status} reason={task.judge_reason} />
      </div>
      {task.tags.length === 0 ? null : (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="Tags">
          {task.tags.map((tag, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a brief may repeat a tag, so the place is part of the key
            <li key={`${tag}-${i}`}>
              <span className="rounded border border-neutral-400 px-1.5 py-0.5 text-xs">{tag}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
