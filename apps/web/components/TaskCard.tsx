import type { TaskSummary } from "@tender/shared";
import Link from "next/link";
import { Amount } from "./Amount";
import { JudgeNote } from "./JudgeNote";
import { PhaseChip } from "./PhaseChip";
import { TeamBadge } from "./TeamBadge";

/**
 * A task on the board: its title, which is the link to its page, the phase it is in, its reward and
 * who posted it. The phase is the one the API worked out when it answered. `onTag` makes each tag a
 * button that filters the board by it.
 */
export function TaskCard({ task, onTag }: { task: TaskSummary; onTag?: (tag: string) => void }) {
  return (
    <li data-testid="task-card" className="rounded border border-neutral-300 p-4">
      <h2 className="font-semibold wrap-anywhere">
        <Link href={`/tasks/${task.id}`} className="underline-offset-4 hover:underline">
          {task.title ?? "Untitled task (no public brief yet)"}
        </Link>
      </h2>
      <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-neutral-700">
        <span>#{task.id}</span>
        <PhaseChip phase={task.phase} />
        <Amount value={task.reward} token={task.token} />
        <span>
          {task.commit_count} {task.commit_count === 1 ? "entry" : "entries"}
        </span>
      </p>
      <p data-testid="poster" className="mt-2 flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="text-neutral-700">Posted by</span>
        <TeamBadge account={task.poster} isTeam={task.is_team_poster} />
      </p>
      <div className="mt-2">
        <JudgeNote status={task.judge_status} reason={task.judge_reason} />
      </div>
      {task.tags.length === 0 ? null : (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="Tags">
          {task.tags.map((tag) => (
            <li key={tag}>
              {onTag === undefined ? (
                <span className="rounded border border-neutral-400 px-1.5 py-0.5 text-xs">
                  {tag}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onTag(tag)}
                  className="min-h-8 rounded border border-neutral-400 px-2 text-xs"
                >
                  {tag}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
