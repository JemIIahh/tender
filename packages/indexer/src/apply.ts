import { type BlobKind, type Db, getBlob } from "@tender/db";
import { BriefSchema, extractEvents, ProfileSchema, type TenderEvent } from "@tender/shared";
import type { IndexedBlock } from "./types";

export interface ApplyOptions {
  /** The Tender contract. Only receipts that ran on this account, and succeeded, are read. */
  contractId: string;
  /**
   * The `chain_cursor.source` this indexer advances: `<network>:<contractId>`, such as
   * `testnet:tender.near`.
   */
  cursorSource: string;
  /** Accounts the team runs. An agent is the team's if it, or its ASP, is one of them. */
  teamAccounts: string[];
}

/**
 * Applies one block: stores each Tender event in `events` and projects it into `tasks`, `funders`,
 * `entries` and `agents`, then moves `chain_cursor` to the block. Returns how many events were new.
 *
 * It is one transaction, so the events, the projections and the cursor commit together or not at
 * all. It is idempotent per event: an event whose (receipt_id, log_index) is stored already is
 * skipped and projects nothing, so a block that is applied twice changes nothing the second time,
 * and the cursor never moves back.
 *
 * The projections follow the contract's own bookkeeping, so that counters read from the index
 * equal those of its views (`get_task`, `get_entry`, `get_agent`):
 * - entries.rs, `commit` and `reveal`: an agent's `entries` goes up on a first commit and its
 *   `reveals` on a reveal, if it is registered at that moment; a first commit also opens the
 *   agent's `earned` slot for the task's token, at zero, if it has none;
 * - settle.rs, `pick`: each winner that is an agent gets a win, and its amount added to the
 *   `earned` slot of the task's token if the agent has one (it never opens one); the account
 *   behind the pick, `by`, gets the `picks_made`;
 * - settle.rs, an empty `pick`: the account behind it gets a `voids_after_reveals` if any entry
 *   had been revealed, and no `picks_made`.
 *
 * An event about a task the index does not hold, because it started after the task was created,
 * is stored in `events` and projects nothing; reconcile fills such tasks in from the chain.
 */
export async function applyBlock(db: Db, block: IndexedBlock, opts: ApplyOptions): Promise<number> {
  const events = extractEvents(block.receipts, opts.contractId);
  return db.tx(async (tx) => {
    let applied = 0;
    for (const logged of events) {
      const event = withoutNul(logged);
      const stored = await tx.query(
        `insert into events (height, block_ts, receipt_id, log_index, event, data, task_id)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (receipt_id, log_index) do nothing
         returning id`,
        [
          block.height,
          block.timestampNs,
          event.receiptId,
          event.logIndex,
          event.event,
          JSON.stringify(event.data),
          taskIdOf(event),
        ],
      );
      if (stored.length === 0) continue;
      applied += 1;
      await project(tx, event, block.height, opts);
    }
    // Last, and never backwards: replaying an old block must not pull the cursor behind newer ones.
    await tx.query(
      `insert into chain_cursor (source, height) values ($1, $2)
       on conflict (source) do update set height = greatest(chain_cursor.height, excluded.height)`,
      [opts.cursorSource, block.height],
    );
    return applied;
  });
}

/** The height of the last block applied for `cursorSource`, or null before the first. */
export async function cursorHeight(db: Db, cursorSource: string): Promise<bigint | null> {
  const [row] = await db.query<{ height: string }>(
    "select height::text as height from chain_cursor where source = $1",
    [cursorSource],
  );
  return row ? BigInt(row.height) : null;
}

type Data<Name extends TenderEvent["event"]> = Extract<TenderEvent, { event: Name }>["data"];

/** The task an event is about: `data.task_id`, or `data.id` for task_created. Null if it has none. */
function taskIdOf(event: TenderEvent): string | null {
  switch (event.event) {
    case "task_created":
      return event.data.id;
    case "task_topped_up":
    case "committed":
    case "revealed":
    case "picked":
    case "voided":
    case "attested_pick":
      return event.data.task_id;
    case "storage_deposit":
    case "deposit":
    case "withdraw":
    case "withdraw_failed":
    case "agent_registered":
    case "delegate_added":
    case "delegate_removed":
      return null;
  }
}

async function project(
  db: Db,
  event: TenderEvent,
  height: bigint,
  opts: ApplyOptions,
): Promise<void> {
  switch (event.event) {
    case "task_created":
      return taskCreated(db, event.data, height);
    case "task_topped_up":
      return taskToppedUp(db, event.data);
    case "committed":
      return committed(db, event.data);
    case "revealed":
      return revealed(db, event.data);
    case "picked":
      return picked(db, event.data, height);
    case "voided":
      return voided(db, event.data, height);
    case "agent_registered":
      return agentRegistered(db, event.data, height, opts);
    // Kept in `events` for the stream and the notifier, and nothing else: no table follows them.
    case "storage_deposit":
    case "deposit":
    case "withdraw":
    case "withdraw_failed":
    case "delegate_added":
    case "delegate_removed":
    case "attested_pick":
      return;
    // An event of the union that no case above names fails to compile here, as it does in taskIdOf.
    default: {
      const unhandled: never = event;
      throw new Error(`no projection for the event ${JSON.stringify(unhandled)}`);
    }
  }
}

// What the tables cannot hold of what the chain allows, so that no event fails a projection. A
// failed projection rolls its block back, and the same block fails again on every retry.
// Reconcile stores the chain's views through the same two helpers, `withoutNul` and `toInt`.
// - A URI is only length-checked on chain, so it may contain a NUL, which neither text nor jsonb
//   stores. A brief title or a profile name, read from a blob, may too.
// - max_entries is a u32 on chain, and the column an int. So are the counts of a view.
const INT_MAX = 2_147_483_647;
const U128_MAX = (2n ** 128n - 1n).toString();
/** U+FFFD, the Unicode replacement character. */
const REPLACEMENT = String.fromCodePoint(0xfffd);

/** A u32 of the chain as an int column holds it: anything above 2147483647 is 2147483647. */
export function toInt(value: number): number {
  return Math.min(value, INT_MAX);
}

/**
 * `value` with every NUL in a string replaced by U+FFFD, in nested arrays and objects as well.
 * Reconcile cleans the views it stores with it too.
 */
export function withoutNul<T>(value: T): T {
  if (typeof value === "string") return value.replaceAll("\u0000", REPLACEMENT) as T;
  if (Array.isArray(value)) return value.map((item) => withoutNul(item)) as T;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).map(([key, item]) => [key, withoutNul(item)]);
    return Object.fromEntries(entries) as T;
  }
  return value;
}

/**
 * The JSON document in the blob stored under `sha256`, if that blob was stored public and as a
 * blob of `kind`. A blob of another kind, a private one, a missing one and one that is not JSON all
 * count as absent, and give null.
 *
 * The hash is read from the chain, where whoever posted the task or registered the agent chose it.
 * It can name any blob in the store: a private one, such as another task's held-out document (whose
 * hash may be public through its `heldout_commitment`), too. What is read here reaches a public
 * row, so only a blob that was stored to be public, as a brief or as a profile, may be.
 */
async function readPublicJsonBlob(db: Db, sha256: string, kind: BlobKind): Promise<unknown> {
  const blob = await getBlob(db, sha256);
  if (blob === null || blob.kind !== kind || !blob.isPublic) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(blob.bytes));
  } catch {
    return null;
  }
}

interface TaskRow {
  token: string;
  commit_count: number;
  reveal_count: number;
}

async function taskRow(db: Db, taskId: string): Promise<TaskRow | undefined> {
  const [row] = await db.query<TaskRow>(
    "select token, commit_count, reveal_count from tasks where id = $1",
    [taskId],
  );
  return row;
}

async function taskCreated(db: Db, d: Data<"task_created">, height: bigint): Promise<void> {
  if (!(await insertTask(db, d, height))) return;
  // The poster pays the whole reward, and is the only funder until someone tops it up.
  await db.query(
    `insert into funders (task_id, account, amount) values ($1, $2, $3)
     on conflict (task_id, account) do nothing`,
    [d.id, d.poster, d.reward],
  );
}

/**
 * Inserts the row of the task that `d` describes, created at block `height`, with no commit, no
 * reveal and no outcome, unless the index holds the task already. Returns whether it inserted it.
 * It inserts no funder: `task_created` makes the poster the first, and reconcile copies the
 * funders from the chain. Every string of `d` must be free of NUL (see `withoutNul`).
 */
export async function insertTask(
  db: Db,
  d: Data<"task_created">,
  height: bigint,
): Promise<boolean> {
  // The brief tells the title, the category and the tags. They are filled only from a public blob
  // of kind brief that is a valid brief; the task is indexed all the same when there is none.
  const parsed = BriefSchema.safeParse(await readPublicJsonBlob(db, d.brief_hash, "brief"));
  const brief = parsed.success ? parsed.data : null;
  const created = await db.query(
    `insert into tasks (
       id, poster, token, reward, fee_bps, brief_uri, brief_hash, criteria_hash,
       heldout_commitment, verifier, created_at, commit_deadline, reveal_deadline, pick_deadline,
       fallback_deadline, max_entries, max_winners, invited, parent, title, category, tags,
       created_height)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
             $20, $21, $22, $23)
     on conflict (id) do nothing
     returning id`,
    [
      d.id,
      d.poster,
      d.token,
      d.reward,
      d.fee_bps,
      d.brief_uri,
      d.brief_hash,
      d.criteria_hash,
      d.heldout_commitment,
      d.verifier,
      d.created_at,
      d.commit_deadline,
      d.reveal_deadline,
      d.pick_deadline,
      d.fallback_deadline,
      toInt(d.max_entries),
      d.max_winners,
      JSON.stringify(d.invited),
      d.parent,
      brief ? withoutNul(brief.title) : null,
      brief?.category ?? null,
      JSON.stringify(brief?.tags ?? []),
      height,
    ],
  );
  return created.length > 0;
}

async function taskToppedUp(db: Db, d: Data<"task_topped_up">): Promise<void> {
  if (!(await taskRow(db, d.task_id))) return;
  await db.query(
    `insert into funders (task_id, account, amount) values ($1, $2, $3)
     on conflict (task_id, account) do update set amount = funders.amount + excluded.amount`,
    [d.task_id, d.funder, d.amount],
  );
  // `reward` is the task's reward after the top-up, not what this funder added.
  await db.query("update tasks set reward = $2 where id = $1", [d.task_id, d.reward]);
}

async function committed(db: Db, d: Data<"committed">): Promise<void> {
  if (d.replaced) {
    // The entry keeps its place and its counts; only its commitment and block change.
    await db.query(
      `update entries set commitment = $3, committed_height = $4
       where task_id = $1 and account = $2`,
      [d.task_id, d.account, d.commitment, d.block_height],
    );
    return;
  }
  const task = await taskRow(db, d.task_id);
  if (!task) return;
  const entry = await db.query(
    `insert into entries (task_id, account, entry_index, commitment, committed_height)
     values ($1, $2, $3, $4, $5)
     on conflict (task_id, account) do nothing
     returning task_id`,
    [d.task_id, d.account, task.commit_count, d.commitment, d.block_height],
  );
  if (entry.length === 0) return;
  await db.query("update tasks set commit_count = commit_count + 1 where id = $1", [d.task_id]);
  // For an agent only (the update finds no row for any other account): one more entry, and an
  // `earned` slot for the task's token at zero unless it has one. Putting the new key on the left
  // of || keeps the amount of a slot that exists.
  await db.query(
    `update agents
        set entries = entries + 1,
            earned = jsonb_build_object($2::text, '0'::text) || earned
      where account = $1`,
    [d.account, task.token],
  );
}

async function revealed(db: Db, d: Data<"revealed">): Promise<void> {
  if (!(await taskRow(db, d.task_id))) return;
  await db.query(
    `update entries set content_hash = $3, uri = $4 where task_id = $1 and account = $2`,
    [d.task_id, d.account, d.content_hash, d.uri],
  );
  await db.query("update tasks set reveal_count = reveal_count + 1 where id = $1", [d.task_id]);
  await db.query("update agents set reveals = reveals + 1 where account = $1", [d.account]);
}

async function picked(db: Db, d: Data<"picked">, height: bigint): Promise<void> {
  const task = await taskRow(db, d.task_id);
  if (!task) return;
  // The outcome is the event as it was logged, `by` included: the chain's view of the outcome has
  // no `by`, so the event is the only place it is recorded.
  await db.query("update tasks set outcome = $2, settled_height = $3 where id = $1", [
    d.task_id,
    JSON.stringify({ kind: "picked", ...d }),
    height,
  ]);
  for (const winner of d.winners) {
    await db.query(
      `update agents
          set wins = wins + 1,
              earned = case when earned ->> $2::text is not null
                then jsonb_set(
                  earned,
                  array[$2::text],
                  to_jsonb(least((earned ->> $2::text)::numeric + $3::numeric, $4::numeric)::text))
                else earned end
        where account = $1`,
      [winner.account, task.token, winner.amount, U128_MAX],
    );
  }
  await db.query("update agents set picks_made = picks_made + 1 where account = $1", [d.by]);
}

async function voided(db: Db, d: Data<"voided">, height: bigint): Promise<void> {
  const task = await taskRow(db, d.task_id);
  if (!task) return;
  await db.query("update tasks set outcome = $2, settled_height = $3 where id = $1", [
    d.task_id,
    JSON.stringify({ kind: "voided", ...d }),
    height,
  ]);
  // Only an empty pick (no_award) has an account behind it. `void_task` leaves `by` null.
  if (d.reason === "no_award" && d.by !== null && task.reveal_count > 0) {
    await db.query(
      "update agents set voids_after_reveals = voids_after_reveals + 1 where account = $1",
      [d.by],
    );
  }
}

async function agentRegistered(
  db: Db,
  d: Data<"agent_registered">,
  height: bigint,
  opts: ApplyOptions,
): Promise<void> {
  // The name comes only from a public blob of kind profile that is a valid profile.
  const profile = ProfileSchema.safeParse(await readPublicJsonBlob(db, d.profile_hash, "profile"));
  const name = profile.success ? withoutNul(profile.data.name) : null;
  const isTeam =
    opts.teamAccounts.includes(d.account) || (d.asp !== null && opts.teamAccounts.includes(d.asp));
  // A first registration writes every counter out as zero. A later one (`updated`) replaces the
  // profile fields only: the counters and the height of the first registration stay.
  await db.query(
    `insert into agents (
       account, asp, profile_uri, profile_hash, tags, name, entries, reveals, wins, earned,
       picks_made, voids_after_reveals, registered_height, is_team)
     values ($1, $2, $3, $4, $5, $6, 0, 0, 0, '{}', 0, 0, $7, $8)
     on conflict (account) do update set
       asp = excluded.asp,
       profile_uri = excluded.profile_uri,
       profile_hash = excluded.profile_hash,
       tags = excluded.tags,
       name = excluded.name,
       is_team = excluded.is_team`,
    [d.account, d.asp, d.profile_uri, d.profile_hash, JSON.stringify(d.tags), name, height, isTeam],
  );
}
