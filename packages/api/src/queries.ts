import type { BlobKind, Db } from "@tender/db";
import {
  BriefSchema,
  type Phase,
  PublicCriteriaSchema,
  type Scorecard,
  ScorecardSchema,
  U64StringSchema,
} from "@tender/shared";
import type { z } from "zod";
import {
  type AccountEntriesResponse,
  type AccountEntry,
  type AgentDetailResponse,
  type AgentSummary,
  DEFAULT_LIMIT,
  type ListAgentsResponse,
  type ListTasksResponse,
  MAX_LIMIT,
  RECENT_ENTRIES,
  type TaskDetail,
  type TaskDetailResponse,
  type TaskEntry,
  type TaskFunder,
  type TaskSummary,
} from "./format";

// The reads behind the routes and the MCP tools. Each function returns the body of its route
// (`format.ts`), built by SQL as far as it can be: ids, amounts, times and heights leave the
// database as text (`::text`) and counts as integers, so no number passes through a JS number
// that a JS number cannot hold.
//
// Every value reaches the database as a parameter. The SQL text is assembled from fixed pieces
// only, with `SqlParams` handing out the placeholders.

class SqlParams {
  readonly values: unknown[] = [];

  /** Keeps `value` and returns the placeholder (`$1`, `$2`, …) that stands for it. */
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

function clampLimit(limit: number): number {
  return Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_LIMIT) : DEFAULT_LIMIT;
}

/**
 * One page of `rows`, which were fetched with one row more than `limit`: the extra row says there
 * is a next page and is not part of this one. The cursor is the last row of the page.
 */
function pageOf<T>(
  rows: T[],
  limit: number,
  cursorOf: (last: T) => string,
): { items: T[]; next_cursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, next_cursor: rows.length > limit && last !== undefined ? cursorOf(last) : null };
}

// ---- Phase ------------------------------------------------------------------------------------

/**
 * The phase of the task row `t` at `now`, which is a placeholder already cast to numeric. This is
 * the rule of `phase` in contract/tender/src/tasks.rs, the same as `phaseAt` in `@tender/shared`
 * (the tests hold them to each other): a task with an outcome is `settled` whatever the time, and
 * otherwise each window runs from one deadline up to, but not including, the next, so at a
 * deadline the next phase has begun.
 */
function phaseSql(now: string): string {
  return `case
    when t.outcome is not null then 'settled'
    when ${now} < t.commit_deadline then 'open'
    when ${now} < t.reveal_deadline then 'revealing'
    when ${now} < t.pick_deadline then 'judging'
    when ${now} < t.fallback_deadline then 'fallback'
    else 'expired'
  end`;
}

// ---- Tasks ------------------------------------------------------------------------------------

/** The columns of a `TaskSummary` for the task row `t`. */
function summaryColumns(now: string, team: string): string {
  return `t.id::text as id,
    t.title,
    t.category,
    t.tags,
    t.token,
    t.reward::text as reward,
    ${phaseSql(now)} as phase,
    t.poster,
    t.verifier,
    t.created_at::text as created_at,
    t.commit_deadline::text as commit_deadline,
    t.reveal_deadline::text as reveal_deadline,
    t.pick_deadline::text as pick_deadline,
    t.fallback_deadline::text as fallback_deadline,
    t.commit_count,
    t.reveal_count,
    (select count(*)::int from working w where w.task_id = t.id) as working_count,
    t.judge_status,
    t.judge_reason,
    (t.poster = any(${team}::text[])
      or exists (select 1 from agents pa where pa.account = t.poster and pa.is_team))
      as is_team_poster,
    t.parent::text as parent,
    t.outcome ->> 'kind' as outcome_kind`;
}

/** What a `TaskDetail` has beyond a `TaskSummary`. */
const DETAIL_COLUMNS = `t.brief_uri,
    t.brief_hash,
    t.criteria_hash,
    t.heldout_commitment,
    t.max_entries,
    t.max_winners,
    t.invited,
    t.fee_bps,
    t.outcome`;

export interface TaskFilter {
  /** Only tasks in this phase at `now`. */
  phase?: Phase;
  /** Only tasks whose brief carries this tag. */
  tag?: string;
  poster?: string;
  verifier?: string;
  /** Only the tasks that name this task (a canonical u64) as their parent. */
  parent?: string;
  /** Page size, from 1 to 50. */
  limit: number;
  /** A task id (a canonical u64): only tasks below it, the next page of an earlier answer. */
  cursor?: string;
}

/**
 * The tasks that fit `f`, newest id first, with each one's phase at `now` (nanoseconds).
 * `teamAccounts` are the accounts the team runs: a task whose poster is one of them, or a
 * registered agent flagged as the team's, has `is_team_poster`.
 */
export async function listTasks(
  db: Db,
  f: TaskFilter,
  now: bigint,
  teamAccounts: readonly string[],
): Promise<ListTasksResponse> {
  const limit = clampLimit(f.limit);
  const p = new SqlParams();
  const nowP = `${p.add(now)}::numeric`;
  const teamP = p.add([...teamAccounts]);
  const where: string[] = [];
  if (f.phase !== undefined) where.push(`${phaseSql(nowP)} = ${p.add(f.phase)}`);
  if (f.tag !== undefined) where.push(`t.tags @> ${p.add(JSON.stringify([f.tag]))}::jsonb`);
  if (f.poster !== undefined) where.push(`t.poster = ${p.add(f.poster)}`);
  if (f.verifier !== undefined) where.push(`t.verifier = ${p.add(f.verifier)}`);
  if (f.parent !== undefined) where.push(`t.parent = ${p.add(f.parent)}::numeric`);
  if (f.cursor !== undefined) where.push(`t.id < ${p.add(f.cursor)}::numeric`);

  const rows = await db.query<TaskSummary>(
    `select ${summaryColumns(nowP, teamP)}
       from tasks t
      ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
      order by t.id desc
      limit ${p.add(limit + 1)}::int`,
    p.values,
  );
  const { items, next_cursor } = pageOf(rows, limit, (last) => last.id);
  return { tasks: items, next_cursor };
}

/**
 * One task with its entries, funders, children and the documents it points at, or null if the
 * index holds no such task (`id` is not a u64, or no task has it).
 */
export async function getTaskDetail(
  db: Db,
  id: string | bigint,
  now: bigint,
  teamAccounts: readonly string[],
): Promise<TaskDetailResponse | null> {
  const taskId = String(id);
  if (!U64StringSchema.safeParse(taskId).success) return null;

  const p = new SqlParams();
  const nowP = `${p.add(now)}::numeric`;
  const teamP = p.add([...teamAccounts]);
  const idP = `${p.add(taskId)}::numeric`;
  const [task] = await db.query<TaskDetail>(
    `select ${summaryColumns(nowP, teamP)}, ${DETAIL_COLUMNS} from tasks t where t.id = ${idP}`,
    p.values,
  );
  if (!task) return null;

  const [entries, funders, children, brief, criteria, scorecard] = await Promise.all([
    db.query<TaskEntry>(
      `select e.account,
              e.entry_index,
              e.committed_height::text as committed_height,
              e.content_hash,
              e.uri,
              (e.content_hash is not null) as revealed,
              (coalesce(a.is_team, false) or e.account = any($2::text[])) as is_team
         from entries e
         left join agents a on a.account = e.account
        where e.task_id = $1::numeric
        order by e.entry_index`,
      [taskId, [...teamAccounts]],
    ),
    db.query<TaskFunder>(
      `select f.account, f.amount::text as amount
         from funders f
         join tasks t on t.id = f.task_id
        where f.task_id = $1::numeric
        order by (f.account = t.poster) desc, f.amount desc, f.account collate "C"`,
      [taskId],
    ),
    // `tasks.id`, not `id`: a bare name in `order by` is the output column, which is text.
    db.query<{ id: string }>(
      "select id::text as id from tasks where parent = $1::numeric order by tasks.id",
      [taskId],
    ),
    publicDocument(db, task.brief_hash, "brief", BriefSchema),
    publicDocument(db, task.criteria_hash, "criteria", PublicCriteriaSchema),
    scorecardOf(db, taskId, task.outcome?.scorecard_hash ?? null),
  ]);

  return {
    task,
    brief,
    criteria,
    entries,
    funders,
    children: children.map((child) => child.id),
    scorecard,
  };
}

/**
 * The scorecard the pick or the empty pick of task `taskId` points at, or null: the task has no
 * outcome or none with a scorecard, the index holds no public scorecard blob under that hash, the
 * blob does not fit `ScorecardSchema`, or it is the scorecard of another task.
 */
export async function getScorecard(db: Db, taskId: string | bigint): Promise<Scorecard | null> {
  const id = String(taskId);
  if (!U64StringSchema.safeParse(id).success) return null;
  const [row] = await db.query<{ hash: string | null }>(
    "select outcome ->> 'scorecard_hash' as hash from tasks where id = $1::numeric",
    [id],
  );
  return scorecardOf(db, id, row?.hash ?? null);
}

async function scorecardOf(db: Db, taskId: string, hash: string | null): Promise<Scorecard | null> {
  if (hash === null) return null;
  const scorecard = await publicDocument(db, hash, "scorecard", ScorecardSchema);
  // The verifier chooses the hash it settles with, so it can name a scorecard of another task.
  return scorecard !== null && scorecard.task_id === taskId ? scorecard : null;
}

/**
 * The JSON document stored under `sha256`, if the blob there is of `kind`, is public, and fits
 * `schema`; otherwise null. A hash on chain is whatever the poster or the verifier wrote, so it
 * can name any blob in the store, a held-out document that is still private among them. Kind and
 * visibility are conditions of the query, so a blob that does not qualify is never read at all.
 *
 * `schema` decides only whether the document is returned. What is returned is the document as
 * `JSON.parse` made it, not the copy that `schema` builds: a schema that creates a new object
 * cannot keep an own `__proto__` key (it would set the prototype, or be skipped), and a document
 * that lost a key no longer hashes to the bytes that were stored.
 */
export async function publicDocument<T>(
  db: Db,
  sha256: string,
  kind: BlobKind,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const [row] = await db.query<{ bytes: Uint8Array }>(
    "select bytes from blobs where sha256 = $1 and kind = $2 and is_public",
    [sha256, kind],
  );
  if (!row) return null;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(row.bytes));
  } catch {
    return null;
  }
  return schema.safeParse(json).success ? (json as T) : null;
}

// ---- Agents -----------------------------------------------------------------------------------

const AGENT_COLUMNS = `a.account,
    a.asp,
    a.name,
    a.tags,
    a.profile_uri,
    a.profile_hash,
    a.registered_height::text as registered_height,
    a.entries,
    a.reveals,
    a.wins,
    a.earned,
    a.picks_made,
    a.voids_after_reveals,
    a.is_team`;

export interface AgentFilter {
  /** Only agents whose profile lists this tag. */
  tag?: string;
  /** Only agents under this provider. */
  asp?: string;
  /** Page size, from 1 to 50. */
  limit: number;
  /** An account: only agents after it, in the order of the accounts. */
  cursor?: string;
}

/**
 * The registered agents that fit `f`, ordered by account (byte order, so the order is the same on
 * every database). `is_team` is what the indexer stored when it read the registration.
 */
export async function listAgents(db: Db, f: AgentFilter): Promise<ListAgentsResponse> {
  const limit = clampLimit(f.limit);
  const p = new SqlParams();
  const where: string[] = [];
  if (f.tag !== undefined) where.push(`a.tags @> ${p.add(JSON.stringify([f.tag]))}::jsonb`);
  if (f.asp !== undefined) where.push(`a.asp = ${p.add(f.asp)}`);
  if (f.cursor !== undefined) where.push(`a.account collate "C" > ${p.add(f.cursor)}`);

  const rows = await db.query<AgentSummary>(
    `select ${AGENT_COLUMNS}
       from agents a
      ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
      order by a.account collate "C"
      limit ${p.add(limit + 1)}::int`,
    p.values,
  );
  const { items, next_cursor } = pageOf(rows, limit, (last) => last.account);
  return { agents: items, next_cursor };
}

/**
 * A registered agent and the latest of its entries, with each task's phase at `now`, or null if
 * the account is no agent.
 */
export async function getAgentDetail(
  db: Db,
  account: string,
  now: bigint,
): Promise<AgentDetailResponse | null> {
  const [agent] = await db.query<AgentSummary>(
    `select ${AGENT_COLUMNS} from agents a where a.account = $1`,
    [account],
  );
  if (!agent) return null;
  const latest = await accountEntries(db, account, now, RECENT_ENTRIES);
  return {
    agent,
    recent_entries: latest.map(({ task_id, title, phase, revealed, won }) => ({
      task_id,
      title,
      phase,
      revealed,
      won,
    })),
  };
}

// ---- Entries ----------------------------------------------------------------------------------

/**
 * Every entry of `account`, newest commit first, with each task's phase at `now`. An account that
 * never entered a task has none, whether or not it is a registered agent.
 */
export async function listEntriesByAccount(
  db: Db,
  account: string,
  now: bigint,
): Promise<AccountEntriesResponse> {
  return { entries: await accountEntries(db, account, now) };
}

async function accountEntries(
  db: Db,
  account: string,
  now: bigint,
  limit?: number,
): Promise<AccountEntry[]> {
  const p = new SqlParams();
  const nowP = `${p.add(now)}::numeric`;
  const accountP = p.add(account);
  return db.query<AccountEntry>(
    `select e.task_id::text as task_id,
            t.title,
            ${phaseSql(nowP)} as phase,
            e.entry_index,
            e.committed_height::text as committed_height,
            e.content_hash,
            e.uri,
            (e.content_hash is not null) as revealed,
            coalesce(
              t.outcome ->> 'kind' = 'picked'
                and (t.outcome -> 'winners') @> jsonb_build_array(jsonb_build_object('account', e.account)),
              false) as won
       from entries e
       join tasks t on t.id = e.task_id
      where e.account = ${accountP}
      order by e.committed_height desc, e.task_id desc
      ${limit === undefined ? "" : `limit ${p.add(limit)}::int`}`,
    p.values,
  );
}
