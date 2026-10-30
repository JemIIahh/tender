import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { Db } from "@tender/db";
import type { AgentView, EntryView, NetworkId, OutcomeView, TaskView } from "@tender/shared";
import { cursorHeight, insertTask, toInt, withoutNul } from "./apply";
import { withIndexLock } from "./lock";

/** The reads of the chain that reconcile makes. `TenderClient` has them all. */
export interface ReconcileChain {
  readonly network: NetworkId;
  readonly contractId: string;
  finalHeight(): Promise<bigint>;
  taskCount(): Promise<bigint>;
  getTask(id: bigint): Promise<TaskView | null>;
  getAllEntries(taskId: bigint): Promise<EntryView[]>;
  getAgent(account: string): Promise<AgentView | null>;
}

export interface ReconcileOptions {
  /** The cursor of the indexer that writes `db`. Default: `<network>:<contractId>` of the chain. */
  cursorSource?: string;
  /** Receives a line for each repair. Default: `console.log`. */
  log?: (message: string) => void;
  /** Ends the pass early: what it has not repaired by then waits for the next one. */
  signal?: AbortSignal;
  /** How long to wait for the index to reach the final height of the views. Default 60 s. */
  catchUpMs?: number;
}

/** How many tasks reconcile inserted, and how many task and agent rows it repaired. */
export interface ReconcileResult {
  inserted: number;
  updated: number;
}

/** How many of the newest tasks, and of the most recently updated agents, a pass compares. */
const RECENT = 50;
const CATCH_UP_MS = 60_000;
/** How often the cursor is looked at while waiting for the index to catch up. */
const CATCH_UP_POLL_MS = 250;

/** The fields of an `OutcomeView`, `kind` first: all that a pass compares of an outcome. */
const OUTCOME_FIELDS = ["kind", "winners", "fee", "scorecard_hash", "scorecard_uri", "reason"];
/** The counters of an agent row, in the order of the view, which a pass compares. */
const AGENT_FIELDS = [
  "entries",
  "reveals",
  "wins",
  "earned",
  "picks_made",
  "voids_after_reveals",
] as const;

/**
 * Repairs the index against the chain's views, and returns what it changed. A pass:
 *
 * - inserts every task the chain has (ids 1 to `taskCount()`) that the index does not, from
 *   `getTask`, with its funders and its entries (`getAllEntries`), so that its page is complete.
 *   That covers the tasks below the highest id, which an index that started late never saw;
 * - for the 50 newest tasks of the index and every one without an outcome, compares
 *   `commit_count`, `reveal_count` and the outcome with the chain;
 * - for the 50 agents of the index that its events updated last, compares the counters with
 *   `getAgent`;
 * - logs `WARN reconcile task=<id> field=<f>` (or `agent=<account>`) for each field that differed,
 *   and repairs it, and `WARN reconcile task=<id> inserted from the chain` for each task inserted.
 *
 * Of an outcome it compares `kind` and the fields of the view. A repair puts the view's fields
 * into the stored outcome and keeps the rest of it, `by` above all, which the view does not have.
 * An outcome the index lacks is stored from the view with `by: null` and `by_source: "reconcile"`.
 * A task without an outcome has SQL NULL, never a JSON null, which would read as settled. What the
 * views cannot tell is left unknown: an outcome stored here has no `settled_height` and a voided
 * one no `refunds`, and an inserted task's `created_height` is the final height that the pass read,
 * by which it had been created.
 *
 * A view is taken as `applyBlock` takes an event, as soon as it is read: a NUL in a string, which
 * the contract lets into a URI, becomes U+FFFD, and a u32 above what an int column holds becomes
 * 2147483647. It is compared in that form too, so a row stored that way agrees with the chain, and
 * no view fails its write, or reads as a mismatch, on every pass.
 *
 * The views show the chain at its final height, which the index trails. Compared as they come, a
 * commit the index has not reached yet would look missed, and a repair would count it twice once
 * the index applied it. So a pass reads the index's height first, then the views, then waits (up to
 * `catchUpMs`) until the index has every block up to the final height read after the views, and
 * leaves alone any task or agent that has an event after the height it read first: whatever it read
 * of those may be from before that event or after it. All the others have not changed since then,
 * on the chain or in the index, and must agree. Each repair is made under the lock the runner
 * applies blocks under, so no block comes between its check and its write. So run it beside the
 * indexer of `db`, in the same process: with no indexer, the index stays short of a live chain's
 * final height and a pass repairs nothing, and the lock is only this process's.
 *
 * A task that the index holds and the chain does not gets a WARN, and is left as it is: the index
 * is then of another chain or contract.
 */
export async function reconcile(
  db: Db,
  chain: ReconcileChain,
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const source = opts.cursorSource ?? `${chain.network}:${chain.contractId}`;
  const log = opts.log ?? console.log;
  const signal = opts.signal;
  const result: ReconcileResult = { inserted: 0, updated: 0 };

  // Before the first view: whatever happened on the chain after this height, the index's events
  // after it show. With no cursor, the index holds no block, and every event comes after.
  const since = (await cursorHeight(db, source)) ?? -1n;

  const missing: Array<{ view: TaskView; entries: EntryView[] }> = [];
  for (const id of await missingTaskIds(db, await chain.taskCount())) {
    if (signal?.aborted) return result;
    const view = await chain.getTask(id);
    if (view === null) continue;
    const entries = (await chain.getAllEntries(id)).map(storableEntry);
    missing.push({ view: storableTask(view), entries });
  }
  const tasks: TaskView[] = [];
  for (const id of await taskIdsToCompare(db)) {
    if (signal?.aborted) return result;
    const view = await chain.getTask(id);
    if (view !== null) tasks.push(storableTask(view));
    else log(`WARN reconcile task=${id} is not on the chain`);
  }
  const agents: AgentView[] = [];
  for (const account of await recentAgents(db)) {
    if (signal?.aborted) return result;
    const view = await chain.getAgent(account);
    if (view !== null) agents.push(storableAgent(view));
  }

  // Every view above shows the chain at this height or below.
  const final = await chain.finalHeight();
  const reached = await indexReaches(db, source, final, opts.catchUpMs ?? CATCH_UP_MS, signal);
  if (reached !== true) {
    if (!signal?.aborted) {
      const at = reached === null ? "holds no block yet" : `is at block ${reached}`;
      log(
        `reconcile: the index ${at}, short of the chain's final height ${final}; nothing repaired`,
      );
    }
    return result;
  }

  for (const { view, entries } of missing) {
    if (signal?.aborted) return result;
    if (await withIndexLock(db, () => insertMissingTask(db, view, entries, since, final))) {
      result.inserted += 1;
      log(`WARN reconcile task=${view.id} inserted from the chain`);
    }
  }
  for (const view of tasks) {
    if (signal?.aborted) return result;
    const fields = await withIndexLock(db, () => repairTask(db, view, since));
    if (fields.length > 0) result.updated += 1;
    for (const field of fields) log(`WARN reconcile task=${view.id} field=${field}`);
  }
  if (signal?.aborted) return result;
  const repaired = await withIndexLock(db, () => repairAgents(db, agents, since));
  for (const { account, fields } of repaired) {
    result.updated += 1;
    for (const field of fields) log(`WARN reconcile agent=${account} field=${field}`);
  }
  return result;
}

/**
 * `view` as the index stores it (see `reconcile`): no NUL, and its counts clamped to an int.
 * `max_entries` is clamped by `insertTask`, as for an event.
 */
function storableTask(view: TaskView): TaskView {
  const task = withoutNul(view);
  return {
    ...task,
    commit_count: toInt(task.commit_count),
    reveal_count: toInt(task.reveal_count),
  };
}

function storableEntry(view: EntryView): EntryView {
  const entry = withoutNul(view);
  return { ...entry, index: toInt(entry.index) };
}

function storableAgent(view: AgentView): AgentView {
  const agent = withoutNul(view);
  return {
    ...agent,
    entries: toInt(agent.entries),
    reveals: toInt(agent.reveals),
    wins: toInt(agent.wins),
    picks_made: toInt(agent.picks_made),
    voids_after_reveals: toInt(agent.voids_after_reveals),
  };
}

/**
 * Waits until the index's cursor is at `height` or past it. Returns true then, or, once `ms` is up
 * or `signal` aborts, the height the cursor is at (null if there is none).
 */
async function indexReaches(
  db: Db,
  source: string,
  height: bigint,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<true | bigint | null> {
  const giveUpAt = Date.now() + ms;
  for (;;) {
    const at = await cursorHeight(db, source);
    if (at !== null && at >= height) return true;
    const left = giveUpAt - Date.now();
    if (left <= 0 || signal?.aborted) return at;
    try {
      await delay(Math.min(CATCH_UP_POLL_MS, left), undefined, { signal });
    } catch {
      return at; // aborted
    }
  }
}

/** The ids from 1 to `count` that the index has no task for, in order. */
async function missingTaskIds(db: Db, count: bigint): Promise<bigint[]> {
  const rows = await db.query<{ id: string }>(
    `select g::text as id from generate_series(1::numeric, $1::numeric) g
      where not exists (select 1 from tasks t where t.id = g)
      order by g`,
    [count],
  );
  return rows.map((row) => BigInt(row.id));
}

/**
 * The 50 newest tasks of the index and every one that has no outcome, in id order. A JSON null is
 * no outcome either, though `outcome is null` is false for it.
 */
async function taskIdsToCompare(db: Db): Promise<bigint[]> {
  const rows = await db.query<{ id: string }>(
    `select id::text as id from tasks
      where outcome is null
         or jsonb_typeof(outcome) <> 'object'
         or id in (select id from tasks order by id desc limit ${RECENT})
      order by id`,
  );
  return rows.map((row) => BigInt(row.id));
}

/**
 * The events that change an agent's row, as (event id, account) pairs: its registration, commits
 * and reveals, the picks it made or won, and the voids it made. `where` narrows the events, as in
 * `and e.height > $1`.
 */
function agentEvents(where: string): string {
  return `
    select e.id, e.data ->> 'account' as account from events e
     where e.event in ('agent_registered', 'committed', 'revealed') ${where}
    union all
    select e.id, e.data ->> 'by' from events e
     where e.event in ('picked', 'voided') ${where}
    union all
    select e.id, w ->> 'account' from events e, jsonb_array_elements(e.data -> 'winners') w
     where e.event = 'picked' ${where}`;
}

/** The 50 agents of the index whose rows its events changed last, latest first. */
async function recentAgents(db: Db): Promise<string[]> {
  const rows = await db.query<{ account: string }>(
    `select t.account from (${agentEvents("")}) t
       join agents a on a.account = t.account
      group by t.account
      order by max(t.id) desc
      limit ${RECENT}`,
  );
  return rows.map((row) => row.account);
}

/** Whether the index holds an event of task `id` after block `since`. */
async function taskChangedSince(db: Db, id: string, since: bigint): Promise<boolean> {
  const rows = await db.query("select 1 from events where task_id = $1 and height > $2 limit 1", [
    id,
    since,
  ]);
  return rows.length > 0;
}

/**
 * Inserts the task of `view`, with `entries`, unless it has an event after `since` (then the
 * runner has inserted it, or it changed while the views were read) or the index holds it. Returns
 * whether it inserted it. The views are storable already (`storableTask`, `storableEntry`).
 */
function insertMissingTask(
  db: Db,
  view: TaskView,
  entries: EntryView[],
  since: bigint,
  createdHeight: bigint,
): Promise<boolean> {
  return db.tx(async (tx) => {
    if (await taskChangedSince(tx, view.id, since)) return false;
    if (!(await insertTask(tx, view, createdHeight))) return false;
    // Rows of a task row that was deleted by hand would be left over: the views are all of it.
    await tx.query("delete from funders where task_id = $1", [view.id]);
    await tx.query("delete from entries where task_id = $1", [view.id]);
    for (const funder of view.funders) {
      await tx.query("insert into funders (task_id, account, amount) values ($1, $2, $3)", [
        view.id,
        funder.account,
        funder.amount,
      ]);
    }
    for (const entry of entries) {
      await tx.query(
        `insert into entries (task_id, account, entry_index, commitment, committed_height,
                              content_hash, uri)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          view.id,
          entry.account,
          entry.index,
          entry.commitment,
          entry.committed_at_block,
          entry.content_hash,
          entry.uri,
        ],
      );
    }
    await tx.query(
      "update tasks set commit_count = $2, reveal_count = $3, outcome = $4 where id = $1",
      [view.id, view.commit_count, view.reveal_count, outcomeFromView(view)],
    );
    return true;
  });
}

/** The outcome of `view` as the index stores one that it did not see happen. Null for none. */
function outcomeFromView(view: TaskView): string | null {
  if (view.outcome === null) return null;
  return JSON.stringify({ ...view.outcome, task_id: view.id, by: null, by_source: "reconcile" });
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Brings the row of `view`'s task in line with it, unless the task has an event after `since`.
 * Returns the fields that differed, each as its WARN line names it.
 */
function repairTask(db: Db, view: TaskView, since: bigint): Promise<string[]> {
  return db.tx(async (tx) => {
    if (await taskChangedSince(tx, view.id, since)) return [];
    const [row] = await tx.query<{
      commit_count: number;
      reveal_count: number;
      outcome: unknown;
      has_outcome: boolean;
    }>(
      `select commit_count, reveal_count, outcome, outcome is not null as has_outcome
         from tasks where id = $1`,
      [view.id],
    );
    if (row === undefined) return [];

    const fields: string[] = [];
    if (row.commit_count !== view.commit_count) fields.push("commit_count");
    if (row.reveal_count !== view.reveal_count) fields.push("reveal_count");
    if (fields.length > 0) {
      await tx.query("update tasks set commit_count = $2, reveal_count = $3 where id = $1", [
        view.id,
        view.commit_count,
        view.reveal_count,
      ]);
    }

    // A JSON null, or anything else but an object, is no outcome; SQL NULL is none.
    const stored = row.has_outcome && isObject(row.outcome) ? row.outcome : null;
    if (view.outcome === null) {
      if (row.has_outcome) {
        fields.push("outcome");
        await tx.query("update tasks set outcome = null, settled_height = null where id = $1", [
          view.id,
        ]);
      }
    } else if (stored === null) {
      fields.push("outcome");
      await tx.query("update tasks set outcome = $2 where id = $1", [
        view.id,
        outcomeFromView(view),
      ]);
    } else {
      const differ = outcomeDifferences(stored, view.outcome);
      if (differ.length > 0) {
        fields.push(...differ.map((field) => `outcome.${field}`));
        await tx.query("update tasks set outcome = $2 where id = $1", [
          view.id,
          JSON.stringify(mergeOutcome(stored, view.outcome)),
        ]);
      }
    }
    return fields;
  });
}

/** The fields of the view's outcome, `kind` among them, that the stored outcome has otherwise. */
function outcomeDifferences(stored: Json, chain: OutcomeView): string[] {
  const view = chain as Json;
  return OUTCOME_FIELDS.filter((field) => !isDeepStrictEqual(stored[field], view[field]));
}

/**
 * `stored` with the view's fields in place of its own, and whatever else it had, such as `by` and
 * `task_id`, kept. A field of the view that the chain's outcome lacks goes, and so do the refunds
 * of a void, if the outcome is no longer one.
 */
function mergeOutcome(stored: Json, chain: OutcomeView): Json {
  const kept = Object.entries(stored).filter(
    ([key]) => !OUTCOME_FIELDS.includes(key) && !(key === "refunds" && stored.kind !== chain.kind),
  );
  return { ...Object.fromEntries(kept), ...chain };
}

interface AgentRow {
  account: string;
  entries: number;
  reveals: number;
  wins: number;
  earned: unknown;
  picks_made: number;
  voids_after_reveals: number;
}

/**
 * Brings each agent's counters in line with its view, but for an agent that has an event after
 * `since`. Returns the agents repaired, each with the fields that differed.
 */
function repairAgents(
  db: Db,
  views: AgentView[],
  since: bigint,
): Promise<Array<{ account: string; fields: string[] }>> {
  return db.tx(async (tx) => {
    if (views.length === 0) return [];
    const changed = new Set(
      (
        await tx.query<{ account: string }>(
          `select distinct account from (${agentEvents("and e.height > $1")}) t`,
          [since],
        )
      ).map((row) => row.account),
    );
    const repaired: Array<{ account: string; fields: string[] }> = [];
    for (const view of views) {
      if (changed.has(view.account)) continue;
      const [row] = await tx.query<AgentRow>(
        `select account, entries, reveals, wins, earned, picks_made, voids_after_reveals
           from agents where account = $1`,
        [view.account],
      );
      if (row === undefined) continue;
      // The view lists one slot per token; the row keeps them as an object of token to amount.
      const earned = Object.fromEntries(view.earned.map((slot) => [slot.token, slot.amount]));
      const want = { ...view, earned };
      const fields = AGENT_FIELDS.filter((field) => !isDeepStrictEqual(row[field], want[field]));
      if (fields.length === 0) continue;
      await tx.query(
        `update agents
            set entries = $2, reveals = $3, wins = $4, earned = $5, picks_made = $6,
                voids_after_reveals = $7
          where account = $1`,
        [
          view.account,
          view.entries,
          view.reveals,
          view.wins,
          JSON.stringify(earned),
          view.picks_made,
          view.voids_after_reveals,
        ],
      );
      repaired.push({ account: view.account, fields });
    }
    return repaired;
  });
}
