import type { TaskDetailResponse } from "@tender/shared";

// A task's lineage, for the task page's swarm tree (plan 06 Task 7): the task, the tasks above it
// and the subtasks under them, read from `GET /v1/tasks/:id` (each answer names its `parent` and
// its `children`), and what each account that posted subtasks made on the task above them.
//
// Any entrant of an open task can post subtasks under it, so a task can have many, posted by
// several accounts. The tree reads at most `MAX_READS` tasks; a subtask past that is named and
// linked, not read, and no margin that would need it is worked out.

/** The most levels the tree shows: a task, its subtasks, and theirs. */
export const TREE_DEPTH = 3;

/** The most tasks one lineage reads, beyond the task the page already has. */
export const MAX_READS = 30;

/** What the tree knows of one task of the lineage. */
export type Read =
  | { state: "loading" }
  | { state: "ready"; detail: TaskDetailResponse }
  /** The index has no such task (yet). */
  | { state: "missing" }
  /** It could not be read just now. */
  | { state: "unread" }
  /** Not read: the lineage had read as many tasks as it reads. */
  | { state: "skipped" };

export interface TreeNode {
  id: string;
  read: Read;
  /** Its subtasks that the tree shows: none past `TREE_DEPTH`. */
  children: TreeNode[];
  /** How many subtasks it has below the levels the tree shows. */
  deeper: number;
}

export interface Lineage {
  root: TreeNode;
  /** The task above the root, when the lineage goes higher than the tree shows. */
  above: string | null;
  /** Every task in the tree. */
  ids: ReadonlySet<string>;
}

type GetTask = (id: string) => Promise<TaskDetailResponse | null>;

/** The children of `read`, as ids, if it was read. */
const childIdsOf = (read: Read): string[] => (read.state === "ready" ? read.detail.children : []);

function idsOf(root: TreeNode): Set<string> {
  const ids = new Set<string>();
  const walk = (node: TreeNode) => {
    ids.add(node.id);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return ids;
}

/**
 * The lineage as far as `current` itself tells it, before anything is read: its parent (to be
 * read), the task itself, and its subtasks (to be read). It is what the page shows at once.
 */
export function initialLineage(current: TaskDetailResponse): Lineage {
  const self: TreeNode = {
    id: current.task.id,
    read: { state: "ready", detail: current },
    children: current.children.map((id) => ({
      id,
      read: { state: "loading" },
      children: [],
      deeper: 0,
    })),
    deeper: 0,
  };
  const root: TreeNode =
    current.task.parent === null
      ? self
      : { id: current.task.parent, read: { state: "loading" }, children: [self], deeper: 0 };
  return { root, above: null, ids: idsOf(root) };
}

/**
 * The lineage of `current`: up to two tasks above it (so that it is in the tree's last level at
 * the deepest), then every subtask of the top one, level by level, to `TREE_DEPTH`. Each task is
 * read once, at most `MAX_READS` in all. A task the index does not have, or that could not be read,
 * stays in the tree as what it is; a read that throws is logged.
 */
export async function loadLineage(current: TaskDetailResponse, getTask: GetTask): Promise<Lineage> {
  let reads = 0;
  const known = new Map<string, Read>([[current.task.id, { state: "ready", detail: current }]]);

  async function read(id: string): Promise<Read> {
    const had = known.get(id);
    if (had !== undefined) return had;
    if (reads >= MAX_READS) return { state: "skipped" };
    reads += 1;
    let got: Read;
    try {
      const detail = await getTask(id);
      got = detail === null ? { state: "missing" } : { state: "ready", detail };
    } catch (error) {
      // The tree says it could not read the task; the original goes to the console.
      console.error(error);
      got = { state: "unread" };
    }
    known.set(id, got);
    return got;
  }

  // Up: the chain from the top of the tree down to `current`, top first.
  const chain: string[] = [current.task.id];
  let above: string | null = null;
  for (let at: Read = known.get(current.task.id) as Read; ; ) {
    const parent = at.state === "ready" ? at.detail.task.parent : null;
    if (parent === null) break;
    if (chain.length === TREE_DEPTH) {
      above = parent;
      break;
    }
    chain.unshift(parent);
    at = await read(parent);
  }

  // Down: the top's subtasks, level by level, so that the reads are shared out across a level.
  const top = chain[0] as string;
  const root: TreeNode = {
    id: top,
    read: known.get(top) ?? { state: "unread" },
    children: [],
    deeper: 0,
  };
  let level: TreeNode[] = [root];
  for (let depth = 1; depth <= TREE_DEPTH && level.length > 0; depth++) {
    const next: TreeNode[] = [];
    for (const node of level) {
      // A task above `current` that could not be read still has the one subtask the chain knows.
      const below = node.id === chain[depth - 1] ? chain[depth] : undefined;
      const ids =
        node.read.state === "ready" ? childIdsOf(node.read) : below === undefined ? [] : [below];
      if (depth === TREE_DEPTH) {
        node.deeper = ids.length;
        continue;
      }
      const childReads = await Promise.all(ids.map(read));
      node.children = ids.map((id, i) => ({
        id,
        read: childReads[i] as Read,
        children: [],
        deeper: 0,
      }));
      next.push(...node.children);
    }
    level = next;
  }

  return { root, above, ids: idsOf(root) };
}

// ---- The lead's margin ------------------------------------------------------------------------

/** What an account that posted subtasks under a task made on it, as far as can be known. */
export type Margin =
  | {
      kind: "ready";
      lead: string;
      token: string;
      /** What the task paid the lead as a winner (0 if it did not win, or the task was voided). */
      paid: bigint;
      /** What the lead put into its subtasks, less what came back to it from voided ones. */
      spent: bigint;
      /** How many subtasks it posted. */
      subtasks: number;
    }
  /** Not settled yet: the task, or a subtask of the lead's, can still pay or refund. */
  | { kind: "pending"; lead: string }
  /** Can't be worked out: a subtask was not read, or pays in another token. */
  | { kind: "unknown"; lead: string; why: "unread" | "token" };

/** The sum of the amounts `rows` hold for `account`. */
function amountFor(rows: ReadonlyArray<{ account: string; amount: string }>, account: string) {
  return rows.reduce((sum, row) => (row.account === account ? sum + BigInt(row.amount) : sum), 0n);
}

/**
 * The margin of each account that posted subtasks under `node`, in the order of their first
 * subtask: what the task paid it, less what it spent on its subtasks. Real figures only: the
 * payout is the task's settled outcome, and what was spent is the account's own funding of each
 * subtask (`funders`) less its refunds from a voided one. None is worked out while the task or a
 * subtask of the account's is unsettled, or when a subtask could not be read (it could be the
 * account's) or pays in another token than the task.
 */
export function marginsOf(node: TreeNode): Margin[] {
  if (node.read.state !== "ready" || node.children.length === 0) return [];
  const parent = node.read.detail;
  const subtasks = node.children.map((child) => child.read);
  const posted = subtasks.flatMap((read) => (read.state === "ready" ? [read.detail] : []));
  const leads = [...new Set(posted.map((child) => child.task.poster))];
  const allRead = posted.length === subtasks.length;

  return leads.map((lead): Margin => {
    if (!allRead) return { kind: "unknown", lead, why: "unread" };
    const mine = posted.filter((child) => child.task.poster === lead);
    if (mine.some((child) => child.task.token !== parent.task.token)) {
      return { kind: "unknown", lead, why: "token" };
    }
    const outcome = parent.task.outcome;
    if (outcome === null || mine.some((child) => child.task.outcome === null)) {
      return { kind: "pending", lead };
    }
    let spent = 0n;
    for (const child of mine) {
      spent += amountFor(child.funders, lead);
      const settled = child.task.outcome;
      if (settled?.kind === "voided") {
        // A void that does not list its refunds cannot say what came back.
        if (settled.refunds === undefined) return { kind: "unknown", lead, why: "unread" };
        spent -= amountFor(settled.refunds, lead);
      }
    }
    const paid = outcome.kind === "picked" ? amountFor(outcome.winners, lead) : 0n;
    return { kind: "ready", lead, token: parent.task.token, paid, spent, subtasks: mine.length };
  });
}
