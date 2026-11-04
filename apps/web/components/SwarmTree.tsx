"use client";

import type { TaskDetailResponse } from "@tender/shared";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "../lib/api";
import { UNTITLED_TASK } from "../lib/copy";
import { phaseOfTask } from "../lib/phase";
import {
  initialLineage,
  type Lineage,
  loadLineage,
  type Margin,
  marginsOf,
  type TreeNode,
} from "../lib/swarm";
import { Amount } from "./Amount";
import { PhaseChip } from "./PhaseChip";
import { TeamBadge } from "./TeamBadge";
import { EYEBROW, FACT_LABEL, PANEL, PANEL_TITLE, SECONDARY } from "./ui";

// The swarm tree of a task page (plan 06 Task 7): the task's lineage, from the task at the top
// down to three levels, each task with its phase, its reward, who posted it and who won it, and for
// each account that posted subtasks, its margin on the task above them (lib/swarm.ts says how that
// is worked out, from real figures only). The task of the page is marked in the tree; the others
// are links to their pages.

/** How long the tree waits for the stream to go quiet before it reads the lineage again. */
const EVENTS_QUIET_MS = 300;

/** The short line from a branch to the card of a subtask, as wide as the branch's indent. */
const TICK =
  "before:absolute before:top-6 before:-left-3 before:h-px before:w-3 before:bg-line sm:before:-left-5 sm:before:w-5";

/** What the tree says of a task it does not have the detail of. */
const ABSENT: Record<Exclude<TreeNode["read"]["state"], "ready">, string> = {
  loading: "Loading…",
  missing: "Not in Tender's index yet.",
  unread: "Couldn't be read just now.",
  skipped: "Not read here.",
};

/** The task's own figures: its phase, its reward, who posted it and who won it. */
function NodeCard({
  node,
  detail,
  nowNs,
  isCurrent,
  linkTestId,
}: {
  node: TreeNode;
  detail: TaskDetailResponse | null;
  nowNs: bigint;
  isCurrent: boolean;
  linkTestId: string;
}) {
  const task = detail?.task ?? null;
  const outcome = task?.outcome ?? null;
  return (
    <div
      data-testid="tree-card"
      className={`relative grid gap-2 rounded-xl border p-3.5 sm:p-4 ${
        isCurrent ? "border-bone/45 bg-raised" : "border-line"
      }`}
    >
      <p className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {isCurrent ? (
          <span aria-current="page" className="flex items-center gap-2.5">
            <span className="font-mono text-[13px] text-bone">Task #{node.id}</span>
            <span className={`${EYEBROW} text-bone`}>This task</span>
          </span>
        ) : (
          // The link covers the card, so that a press anywhere on it opens the task.
          <Link
            data-testid={linkTestId}
            href={`/tasks/${node.id}`}
            className="font-mono text-[13px] text-bone underline decoration-bone/40 underline-offset-4 transition-colors after:absolute after:inset-0 after:rounded-xl hover:decoration-bone motion-reduce:transition-none"
          >
            Task #{node.id}
          </Link>
        )}
        {task === null ? null : <PhaseChip phase={phaseOfTask(task, nowNs)} />}
        {task === null ? null : (
          // On a phone the reward has a line of its own on every card; wider, it sits on the right.
          <span
            data-testid="tree-reward"
            className="basis-full text-bone tabular-nums sm:ml-auto sm:basis-auto"
          >
            <Amount value={task.reward} token={task.token} />
          </span>
        )}
      </p>
      {task === null ? (
        <p className="text-sm text-muted">{ABSENT[node.read.state as keyof typeof ABSENT]}</p>
      ) : (
        <>
          <p className="text-[15px] leading-snug text-bone wrap-anywhere">
            {task.title ?? UNTITLED_TASK}
          </p>
          <div className="grid gap-1 text-sm text-muted">
            <p data-testid="tree-poster" className="flex min-w-0 flex-wrap items-center gap-x-2">
              <span className="shrink-0">Posted by</span>
              <span className="min-w-0 text-bone">
                <TeamBadge account={task.poster} isTeam={task.is_team_poster} />
              </span>
            </p>
            {outcome === null ? null : (
              <p data-testid="tree-winner" className="flex min-w-0 flex-wrap items-center gap-x-2">
                {outcome.kind === "picked" ? (
                  <>
                    <span className="shrink-0">Won by</span>
                    <span className="min-w-0 font-mono text-[13px] text-bone wrap-anywhere">
                      {outcome.winners.map((winner) => winner.account).join(", ")}
                    </span>
                  </>
                ) : (
                  <span>Refunded to its funders</span>
                )}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** A margin as a signed amount: `+3.50 tUSDC`, `−1.00 tUSDC`, or `0.00 tUSDC`. */
function Signed({ value, token }: { value: bigint; token: string }) {
  const sign = value > 0n ? "+" : value < 0n ? "−" : "";
  return (
    <span data-testid="margin-value" className="tabular-nums">
      {sign}
      <Amount value={(value < 0n ? -value : value).toString()} token={token} />
    </span>
  );
}

/** What one account made on `taskId`, the task it posted subtasks under. */
function MarginBox({ margin, taskId }: { margin: Margin; taskId: string }) {
  const lead = (
    <span className="min-w-0 font-mono text-[13px] text-bone wrap-anywhere">{margin.lead}</span>
  );
  if (margin.kind !== "ready") {
    return (
      <div data-testid="lead-margin" className="grid gap-1 rounded-xl bg-raised p-4 text-sm">
        <p className={FACT_LABEL}>Lead's margin</p>
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-muted">
          {lead}
          <span>
            {margin.kind === "pending"
              ? `· shown once Task #${taskId} and its subtasks are settled.`
              : margin.why === "token"
                ? "· not worked out: its subtasks pay in another token."
                : "· not worked out: not every subtask could be read here."}
          </span>
        </p>
      </div>
    );
  }
  return (
    <div data-testid="lead-margin" className="grid gap-3 rounded-xl bg-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="grid gap-1">
          <span className={FACT_LABEL}>Lead's margin</span>
          {lead}
        </p>
        <p className="text-xl leading-tight font-medium tracking-[-0.02em] text-bone">
          <Signed value={margin.paid - margin.spent} token={margin.token} />
        </p>
      </div>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">Paid for Task #{taskId}</dt>
        <dd data-testid="margin-paid" className="text-right text-bone tabular-nums">
          <Amount value={margin.paid.toString()} token={margin.token} />
        </dd>
        <dt className="text-muted">
          {margin.subtasks === 1 ? "Spent on 1 subtask" : `Spent on ${margin.subtasks} subtasks`}
        </dt>
        <dd data-testid="margin-spent" className="text-right text-bone tabular-nums">
          −<Amount value={margin.spent.toString()} token={margin.token} />
        </dd>
      </dl>
    </div>
  );
}

/** One task of the tree, its subtasks under it, and the margins on it. */
function NodeItem({
  node,
  current,
  parentId,
  nowNs,
}: {
  node: TreeNode;
  current: TaskDetailResponse;
  parentId: string | null;
  nowNs: bigint;
}) {
  const isCurrent = node.id === current.task.id;
  // The page's own task is always the latest the page has; the others are as the tree read them.
  const detail = isCurrent ? current : node.read.state === "ready" ? node.read.detail : null;
  const shown = isCurrent ? { ...node, read: { state: "ready" as const, detail: current } } : node;
  const read = shown.children.filter((child) => child.read.state !== "skipped");
  const skipped = shown.children.filter((child) => child.read.state === "skipped");
  const margins = marginsOf(shown);
  // The subtasks of the page's task keep the links the page has always had for them.
  const linkTestId = parentId !== null && parentId === current.task.id ? "child-link" : "tree-link";
  const hasBelow = read.length > 0 || skipped.length > 0 || shown.deeper > 0;

  return (
    <li
      data-testid="tree-node"
      data-task-id={node.id}
      // A subtask's tick off its branch line.
      className={`relative grid gap-2.5 ${parentId === null ? "" : TICK}`}
    >
      <NodeCard
        node={node}
        detail={detail}
        nowNs={nowNs}
        isCurrent={isCurrent}
        linkTestId={linkTestId}
      />
      {hasBelow ? (
        <ul
          aria-label={`Subtasks of Task #${node.id}`}
          className="ml-3 grid gap-2.5 border-l border-line pl-3 sm:ml-5 sm:pl-5"
        >
          {read.map((child) => (
            <NodeItem
              key={child.id}
              node={child}
              current={current}
              parentId={node.id}
              nowNs={nowNs}
            />
          ))}
          {skipped.length === 0 ? null : (
            <li className="grid gap-2 text-sm text-muted">
              <p>
                {skipped.length === 1 ? "One more subtask:" : `${skipped.length} more subtasks:`}
              </p>
              <p className="flex flex-wrap gap-2">
                {skipped.map((child) => (
                  <Link
                    key={child.id}
                    data-testid={isCurrent ? "child-link" : "tree-link"}
                    href={`/tasks/${child.id}`}
                    className={SECONDARY}
                  >
                    Task #{child.id}
                  </Link>
                ))}
              </p>
            </li>
          )}
          {shown.deeper === 0 ? null : (
            <li className="text-sm text-muted">
              {shown.deeper === 1
                ? "One more subtask below, on its own page."
                : `${shown.deeper} more subtasks below, on its own page.`}
            </li>
          )}
        </ul>
      ) : null}
      {margins.length === 0 ? null : (
        <div className="ml-3 grid gap-2.5 pl-3 sm:ml-5 sm:pl-5">
          {margins.map((margin) => (
            <MarginBox key={margin.lead} margin={margin} taskId={node.id} />
          ))}
        </div>
      )}
    </li>
  );
}

/**
 * The swarm tree of `current`, shown on a task that has a task above it or subtasks under it.
 * It shows at once what `current` itself says (its parent and its subtasks), and fills in as the
 * lineage is read. `refresh` goes up when the event stream says a task in the tree was settled or
 * topped up, and the tree reads its lineage again a moment later; `onIds` hears which tasks are in
 * it, for the page to tell the stream's events apart.
 */
export function SwarmTree({
  current,
  nowNs,
  refresh,
  onIds,
}: {
  current: TaskDetailResponse;
  nowNs: bigint;
  refresh: number;
  onIds: (ids: ReadonlySet<string>) => void;
}) {
  const [lineage, setLineage] = useState<Lineage>(() => initialLineage(current));
  const headingId = useId();
  const latest = useRef(0);
  // The task as of the latest render, for a read that starts later (the stream's).
  const now = useRef(current);
  useEffect(() => {
    now.current = current;
  });

  const load = useCallback(() => {
    const request = ++latest.current;
    loadLineage(now.current, (id) => api.getTask(id)).then(
      (next) => {
        if (request === latest.current) setLineage(next);
      },
      (error) => console.error(error),
    );
  }, []);

  // The lineage is read again when the task's place in it changes: another parent, or subtasks
  // added. A reload of the task that changes neither asks nothing more.
  const shape = `${current.task.id}|${current.task.parent ?? ""}|${current.children.join(",")}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shape` is the key: `load` reads the task from the ref
  useEffect(() => {
    load();
  }, [shape, load]);

  useEffect(() => {
    if (refresh === 0) return;
    const timer = setTimeout(load, EVENTS_QUIET_MS);
    return () => clearTimeout(timer);
  }, [refresh, load]);

  useEffect(() => {
    onIds(lineage.ids);
  }, [lineage, onIds]);

  return (
    <section data-testid="swarm-tree" aria-labelledby={headingId} className={PANEL}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={headingId} className={PANEL_TITLE}>
          Swarm
        </h2>
        <p data-testid="tree-summary" className="font-mono text-xs text-muted">
          {`${lineage.ids.size} tasks`}
        </p>
      </div>
      {lineage.above === null ? null : (
        <p className="text-sm text-muted">
          It goes higher:{" "}
          <Link href={`/tasks/${lineage.above}`} className="text-bone underline underline-offset-4">
            Task #{lineage.above}
          </Link>{" "}
          is above the top of this tree.
        </p>
      )}
      <ul aria-label="Lineage" className="grid">
        <NodeItem node={lineage.root} current={current} parentId={null} nowNs={nowNs} />
      </ul>
    </section>
  );
}
