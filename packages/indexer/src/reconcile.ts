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
/**
 * How many blocks apart two answers about the chain may be, which a pass allows for (P03-R18).
 * Off the sandbox the views and the final height come from a load-balanced RPC, whose nodes can be
 * a few blocks apart, and the index follows neardata.
 */
const SKEW_BLOCKS = 20n;
/**
 * An index further than this short of the chain's final height is catching up, too far behind to
 * get past it within a pass's wait: the pass reads no view.
 */
const TOO_FAR_BEHIND = 200n;

/** Why a field that differs from its view is kept, as the WARN line says it. */
const OUTCOME_IS_FINAL = "the view has none, and an outcome is final";
const COUNTS_ONLY_GROW = "the view is lower, and counts only grow";

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
 * The views show the chain at its final height, which the index trails, and off the sandbox they
 * come from a load-balanced RPC whose nodes can be some blocks apart. Compared as they come, a
 * commit the index has not reached yet would look missed, and a repair would count it twice once
 * the index applied it; an outcome a lagging node has not seen yet would look gone. So a pass:
 *
 * - reads the index's height C0 and, with it, its last event in a block 20 or more below C0;
 * - reads the views;
 * - waits (up to `catchUpMs`) until the index is at least 20 blocks past the final height that it
 *   read after the views;
 * - leaves alone every task and agent with an event after that last one: what it read of those
 *   may be from before that event or after it.
 *
 * A view from anywhere between 20 blocks below C0 and 20 above the final height shows each of the
 * others as the index has it, so they must agree. Each repair is made under the lock the runner
 * applies blocks under, so no block comes between its check and its write. So run it beside the
 * indexer of `db`, in the same process: with no indexer, the index stays short of a live chain's
 * final height and a pass repairs nothing, and the lock is only this process's. A pass reads no
 * view while the index holds no block, or is more than 200 blocks short of the chain's final
 * height, which is too far to catch up within the wait; it logs a line, and repairs nothing.
 *
 * It never takes an outcome away. An outcome is final on chain, so a view without one, of a task
 * whose row has one, is stale: that gets a WARN, and the row stays as it is. Nor does it keep an
 * outcome of the other kind, which cannot be this task's: that one is replaced as if the row had
 * none. Nor does it lower a count (P03-R21): `commit_count`, `reveal_count` and every counter of an
 * agent only grow on chain, and so does each slot of `earned`, so a view with less is stale and
 * gets a WARN, `kept: the view is lower, and counts only grow`; a count the view has more of is
 * raised. Lowered, a task's count would give its next entry the index of one it has. Nor does it
 * delete a row: an inserted task's funders and entries are written over from the views, and any
 * the views lack (`cleanup` removes entries from the chain) are kept.
 *
 * A task that the index holds and the chain does not, and that has no event after `since`, gets a
 * WARN and is left as it is: the index is then of another chain or contract.
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

  // Before the first view. What moved on the chain since 20 blocks below the index's height shows
  // in the index's events after `since`, by the time it is 20 blocks past the final height.
  const start = await startOfPass(db, source);
  if (start === null) {
    log("reconcile: the index holds no block yet; nothing repaired");
    return result;
  }
  const behind = (await chain.finalHeight()) - start.height;
  if (behind > TOO_FAR_BEHIND) {
    log(
      `reconcile: the index is at block ${start.height}, ${behind} blocks short of the chain's ` +
        `final height ${start.height + behind}; nothing repaired`,
    );
    return result;
  }
  const { since } = start;

  const missing: Array<{ view: TaskView; entries: EntryView[] }> = [];
  for (const id of await missingTaskIds(db, await chain.taskCount())) {
    if (signal?.aborted) return result;
    const view = await chain.getTask(id);
    if (view === null) continue;
    const entries = (await chain.getAllEntries(id)).map(storableEntry);
    missing.push({ view: storableTask(view), entries });
  }
  const tasks: Array<{ id: bigint; view: TaskView | null }> = [];
  for (const id of await taskIdsToCompare(db)) {
    if (signal?.aborted) return result;
    const view = await chain.getTask(id);
    tasks.push({ id, view: view === null ? null : storableTask(view) });
  }
  const agents: AgentView[] = [];
  for (const account of await recentAgents(db)) {
    if (signal?.aborted) return result;
    const view = await chain.getAgent(account);
    if (view !== null) agents.push(storableAgent(view));
  }

  // Every view above shows the chain at this height or below, give or take SKEW_BLOCKS.
  const final = await chain.finalHeight();
  const target = final + SKEW_BLOCKS;
  const reached = await indexReaches(db, source, target, opts.catchUpMs ?? CATCH_UP_MS, signal);
  if (reached !== true) {
    if (!signal?.aborted) {
      const at = reached === null ? "holds no block" : `is at block ${reached}`;
      log(
        `reconcile: the index ${at}, short of block ${target}, ${SKEW_BLOCKS} past the chain's ` +
          "final height; nothing repaired",
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
  for (const { id, view } of tasks) {
    if (signal?.aborted) return result;
    const repair = await withIndexLock(db, () => repairTask(db, id, view, since));
    if (repair.fields.length > 0) result.updated += 1;
    for (const field of repair.fields) log(`WARN reconcile task=${id} field=${field}`);
    for (const { field, why } of repair.kept) {
      log(`WARN reconcile task=${id} field=${field} kept: ${why}`);
    }
    if (repair.notOnChain) log(`WARN reconcile task=${id} is not on the chain`);
  }
  if (signal?.aborted) return result;
  const repaired = await withIndexLock(db, () => repairAgents(db, agents, since));
  for (const { account, fields, kept } of repaired) {
    if (fields.length > 0) result.updated += 1;
    for (const field of fields) log(`WARN reconcile agent=${account} field=${field}`);
    for (const field of kept) {
      log(`WARN reconcile agent=${account} field=${field} kept: ${COUNTS_ONLY_GROW}`);
    }
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
 * The index's height, and the id of its last event in a block at least SKEW_BLOCKS below that
 * height (0 if it has none), read in one statement. Null when the index holds no block yet.
 */
async function startOfPass(
  db: Db,
  source: string,
): Promise<{ height: bigint; since: bigint } | null> {
  const [row] = await db.query<{ height: string; since: string | null }>(
    `select c.height::text as height,
            (select e.id::text from events e
              where e.height <= c.height - $2
              order by e.id desc
              limit 1) as since
       from chain_cursor c
      where c.source = $1`,
    [source, SKEW_BLOCKS],
  );
  if (row === undefined) return null;
  return { height: BigInt(row.height), since: BigInt(row.since ?? "0") };
}

/**
 * Waits until the index's cursor is at `height` or past it. Returns true then, or, once `ms` is up
 * or `signal` aborts, the height the cursor is at.
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
 * `and e.id > $1`.
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

/**
 * Whether the index holds an event of task `id` after the event `since`. The one runner inserts
 * the events block by block, so their ids go up with the blocks.
 */
async function taskChangedSince(db: Db, id: string, since: bigint): Promise<boolean> {
  const rows = await db.query("select 1 from events where task_id = $1 and id > $2 limit 1", [
    id,
    since,
  ]);
  return rows.length > 0;
}

/**
 * Inserts the task of `view`, with `entries`, unless it has an event after `since` (then the
 * runner has inserted it, or it changed while the views were read) or the index holds it. Returns
 * whether it inserted it. The views are storable already (`storableTask`, `storableEntry`).
 *
 * A funder or an entry that the index holds already is written over from the views, and one the
 * views lack is kept: `cleanup` removes entries from the chain, and the index may hold the only
 * copy of one.
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
    for (const funder of view.funders) {
      await tx.query(
        `insert into funders (task_id, account, amount) values ($1, $2, $3)
         on conflict (task_id, account) do update set amount = excluded.amount`,
        [view.id, funder.account, funder.amount],
      );
    }
    for (const entry of entries) {
      await tx.query(
        `insert into entries (task_id, account, entry_index, commitment, committed_height,
                              content_hash, uri)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (task_id, account) do update set
           entry_index = excluded.entry_index,
           commitment = excluded.commitment,
           committed_height = excluded.committed_height,
           content_hash = excluded.content_hash,
           uri = excluded.uri`,
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

interface TaskRepair {
  /** The fields that differed and were repaired, each as its WARN line names it. */
  fields: string[];
  /** The fields that differed and were kept, since the view is stale, with why. */
  kept: Array<{ field: string; why: string }>;
  /** Whether the index holds the task, and the chain has none by its id. */
  notOnChain: boolean;
}

/**
 * Brings the row of task `id` in line with `view`, its view, unless the task has an event after
 * `since`. A null `view` is a task that the chain does not have.
 */
function repairTask(db: Db, id: bigint, view: TaskView | null, since: bigint): Promise<TaskRepair> {
  return db.tx(async (tx) => {
    const none: TaskRepair = { fields: [], kept: [], notOnChain: false };
    if (await taskChangedSince(tx, `${id}`, since)) return none;
    if (view === null) {
      const held = await tx.query("select 1 from tasks where id = $1", [id]);
      return { ...none, notOnChain: held.length > 0 };
    }
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
    if (row === undefined) return none;

    const fields: string[] = [];
    const kept: TaskRepair["kept"] = [];
    // Raised, never lowered: a view with fewer is stale (P03-R21).
    const counts = { commit_count: row.commit_count, reveal_count: row.reveal_count };
    for (const field of ["commit_count", "reveal_count"] as const) {
      if (view[field] > row[field]) {
        fields.push(field);
        counts[field] = view[field];
      } else if (view[field] < row[field]) {
        kept.push({ field, why: COUNTS_ONLY_GROW });
      }
    }
    if (fields.length > 0) {
      await tx.query("update tasks set commit_count = $2, reveal_count = $3 where id = $1", [
        view.id,
        counts.commit_count,
        counts.reveal_count,
      ]);
    }

    // A JSON null, or anything else but an object, is no outcome, and SQL NULL is none: both are
    // read as unsettled. An outcome stored from the view has no `by` and no settled height.
    const stored = row.has_outcome && isObject(row.outcome) ? row.outcome : null;
    const storeFromView = () =>
      tx.query("update tasks set outcome = $2, settled_height = null where id = $1", [
        view.id,
        outcomeFromView(view),
      ]);
    if (view.outcome === null) {
      // Final on chain: an outcome that the view lacks is the view's to catch up on, not the row's
      // to lose. A JSON null is no outcome, only one that reads as settled.
      if (stored !== null) kept.push({ field: "outcome", why: OUTCOME_IS_FINAL });
      else if (row.has_outcome) {
        fields.push("outcome");
        await storeFromView();
      }
    } else if (stored === null) {
      fields.push("outcome");
      await storeFromView();
    } else if (stored.kind !== view.outcome.kind) {
      // The kind never changes on chain: this outcome is not the task's, nor its `by`.
      fields.push("outcome.kind");
      await storeFromView();
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
    return { fields, kept, notOnChain: false };
  });
}

/** The fields of the view's outcome, `kind` among them, that the stored outcome has otherwise. */
function outcomeDifferences(stored: Json, chain: OutcomeView): string[] {
  const view = chain as Json;
  return OUTCOME_FIELDS.filter((field) => !isDeepStrictEqual(stored[field], view[field]));
}

/**
 * `stored`, an outcome of the view's kind, with the view's fields in place of its own, and the rest
 * of it (`by`, `task_id`, a void's `refunds`) kept. A field of the view that the chain's outcome
 * lacks goes.
 */
function mergeOutcome(stored: Json, chain: OutcomeView): Json {
  const kept = Object.entries(stored).filter(([key]) => !OUTCOME_FIELDS.includes(key));
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
 * Brings each agent's counters up to its view, but for an agent that has an event after `since`.
 * A counter, or a slot of `earned`, is raised where the view has more and kept where it has less
 * (P03-R21). Returns the agents whose counters differed, each with the fields raised and kept.
 */
function repairAgents(
  db: Db,
  views: AgentView[],
  since: bigint,
): Promise<Array<{ account: string; fields: string[]; kept: string[] }>> {
  return db.tx(async (tx) => {
    if (views.length === 0) return [];
    const changed = new Set(
      (
        await tx.query<{ account: string }>(
          `select distinct account from (${agentEvents("and e.id > $1")}) t`,
          [since],
        )
      ).map((row) => row.account),
    );
    const repaired: Array<{ account: string; fields: string[]; kept: string[] }> = [];
    for (const view of views) {
      if (changed.has(view.account)) continue;
      const [row] = await tx.query<AgentRow>(
        `select account, entries, reveals, wins, earned, picks_made, voids_after_reveals
           from agents where account = $1`,
        [view.account],
      );
      if (row === undefined) continue;
      const next = { ...row };
      const fields: string[] = [];
      const kept: string[] = [];
      for (const field of AGENT_FIELDS) {
        if (field === "earned") {
          const earned = mergeEarned(row.earned, view.earned);
          if (!isDeepStrictEqual(row.earned, earned.slots)) {
            fields.push(field);
            next.earned = earned.slots;
          }
          if (earned.lower) kept.push(field);
        } else if (view[field] > row[field]) {
          fields.push(field);
          next[field] = view[field];
        } else if (view[field] < row[field]) {
          kept.push(field);
        }
      }
      if (fields.length === 0 && kept.length === 0) continue;
      if (fields.length > 0) {
        await tx.query(
          `update agents
              set entries = $2, reveals = $3, wins = $4, earned = $5, picks_made = $6,
                  voids_after_reveals = $7
            where account = $1`,
          [
            view.account,
            next.entries,
            next.reveals,
            next.wins,
            JSON.stringify(next.earned),
            next.picks_made,
            next.voids_after_reveals,
          ],
        );
      }
      repaired.push({ account: view.account, fields, kept });
    }
    return repaired;
  });
}

/**
 * The row's `earned` slots (token to amount) with the view's merged in, each at the larger amount:
 * on chain a slot only opens, and only grows. `lower` says whether the view lacks a slot of the
 * row, or has less in one. A row's slot that is not an amount is replaced by the view's.
 */
function mergeEarned(
  row: unknown,
  view: AgentView["earned"],
): { slots: Record<string, string>; lower: boolean } {
  const slots: Record<string, string> = {};
  if (isObject(row)) {
    for (const [token, amount] of Object.entries(row)) {
      if (typeof amount === "string" && /^\d+$/.test(amount)) slots[token] = amount;
    }
  }
  const held = { ...slots };
  let lower = false;
  for (const { token, amount } of view) {
    const have = held[token];
    if (have === undefined || BigInt(amount) > BigInt(have)) slots[token] = amount;
    else if (BigInt(amount) < BigInt(have)) lower = true;
  }
  const listed = new Set(view.map((slot) => slot.token));
  if (Object.keys(held).some((token) => !listed.has(token))) lower = true;
  return { slots, lower };
}
