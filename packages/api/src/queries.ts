import type { BlobKind, Db } from "@tender/db";
import {
  BriefSchema,
  type ListServicesResponse,
  type Phase,
  type PublicCriteria,
  PublicCriteriaSchema,
  type Scorecard,
  ScorecardSchema,
  type Service,
  sha256Hex,
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
  MAX_LISTED,
  RECENT_ENTRIES,
  type TaskDetail,
  type TaskDetailResponse,
  type TaskEntry,
  type TaskFunder,
  type TaskOutcome,
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

// ---- The team ---------------------------------------------------------------------------------

/**
 * The provider of `account`, a column, by the registry's rule (`asp_of` in
 * contract/tender/src/registry.rs): the account's parent when the parent has two labels or more,
 * as `acme.near` is of `bot1.acme.near`, and null otherwise, as for `alice.near`, whose parent is
 * a top-level account. It is the `asp` the contract records when an agent registers, so it is the
 * same for an account that registered and for one that never did.
 */
function providerSql(account: string): string {
  return `substring(${account} from '^[^.]+[.](.+[.].+)$')`;
}

/**
 * Whether the team runs `account`, a column: it is one of the team's accounts (`team`, a
 * placeholder of a text array), or its provider is. It is worked out from the list of the request,
 * for agents, entrants and posters alike, so a change to `TEAM_ACCOUNTS` shows at once, and an
 * entrant or a poster that never registered as an agent is labelled as one that did. An account
 * with no provider compares a null, which `coalesce` makes a no.
 */
function teamSql(account: string, team: string): string {
  return `(${account} = any(${team}::text[])
      or coalesce(${providerSql(account)} = any(${team}::text[]), false))`;
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
    ${teamSql("t.poster", team)} as is_team_poster,
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
  /** Only the pinned tasks whose invited list names this account. */
  invited?: string;
  /** Page size, from 1 to 50. */
  limit: number;
  /** A task id (a canonical u64): only tasks below it, the next page of an earlier answer. */
  cursor?: string;
}

/**
 * The tasks that fit `f`, newest id first, with each one's phase at `now` (nanoseconds).
 * `teamAccounts` are the accounts the team runs: a task whose poster is one of them, or runs under
 * one as its provider (`teamSql`), has `is_team_poster`.
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
  if (f.invited !== undefined) {
    where.push(`t.invited @> ${p.add(JSON.stringify([f.invited]))}::jsonb`);
  }
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
 * index holds no such task (`id` is not a u64, or no task has it). It lists the first `MAX_LISTED`
 * entries in entrant order, and as many children, oldest first: the task's `commit_count` is how
 * many entries it has, and `listTasks` with `parent` pages through all of its children.
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
              ${teamSql("e.account", "$2")} as is_team
         from entries e
        where e.task_id = $1::numeric
        order by e.entry_index
        limit $3::int`,
      [taskId, [...teamAccounts], MAX_LISTED],
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
      "select id::text as id from tasks where parent = $1::numeric order by tasks.id limit $2::int",
      [taskId, MAX_LISTED],
    ),
    publicDocument(db, task.brief_hash, "brief", BriefSchema),
    publicDocument(db, task.criteria_hash, "criteria", PublicCriteriaSchema),
    scorecardOf(db, task),
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
 * The scorecard task `taskId` was settled with, as `scorecardOf` finds it, or null. The REST routes
 * and the MCP tools all read it here, or through `getTaskDetail`, which asks the same.
 */
export async function getScorecard(db: Db, taskId: string | bigint): Promise<Scorecard | null> {
  const id = String(taskId);
  if (!U64StringSchema.safeParse(id).success) return null;
  const [task] = await db.query<Settled>(
    `select id::text as id, poster, verifier, outcome, criteria_hash, heldout_commitment
       from tasks where id = $1::numeric`,
    [id],
  );
  return task === undefined ? null : scorecardOf(db, task);
}

/**
 * What a scorecard is held to: the task's id, its two accounts, its outcome, and the two hashes it
 * committed to at posting.
 */
type Settled = Pick<
  TaskDetail,
  "id" | "poster" | "verifier" | "outcome" | "criteria_hash" | "heldout_commitment"
>;

/**
 * The scorecard the pick or the empty pick of `task` points at, or null: the task has no outcome or
 * none with a scorecard, the index holds no public scorecard blob under that hash, the blob does
 * not fit `ScorecardSchema`, or it is not the card of this settlement.
 *
 * Whoever settles chooses the hash: the verifier, or the poster when it picks after the pick
 * deadline. So the hash can name any public scorecard, the card of another task, or the card the
 * Judge published before a pick of its own that failed, beside a payout the Judge did not make.
 * A card is shown only when it is the task's (`task_id`), it is the word of the task's verifier or
 * poster (`verifier`), it rests on what the task committed to (`criteria_hash` and
 * `heldout_commitment` are the task's own, both read from the index: no call to the chain), and its
 * winners are those the outcome paid, each account with its share in the same order, or none for an
 * empty pick. A poster that pays exactly what the Judge's card says has the Judge's card shown, as
 * it is the truth of that payout.
 *
 * The two hashes are on chain, so a card that names others is not the scorecard of this task's
 * criteria and held-out, whoever wrote it: it is a re-check of something else. The Judge's cards
 * always carry the task's (`buildScorecard` refuses to make one otherwise). A verifier that writes
 * its own card has to copy them from the task.
 */
async function scorecardOf(db: Db, task: Settled): Promise<Scorecard | null> {
  const hash = task.outcome?.scorecard_hash ?? null;
  if (task.outcome === null || hash === null) return null;
  const scorecard = await publicDocument(db, hash, "scorecard", ScorecardSchema);
  if (scorecard === null || scorecard.task_id !== task.id) return null;
  if (scorecard.verifier !== task.verifier && scorecard.verifier !== task.poster) return null;
  if (scorecard.criteria_hash !== task.criteria_hash) return null;
  if (scorecard.heldout_commitment !== task.heldout_commitment) return null;
  return samePayout(scorecard.winners, task.outcome) ? scorecard : null;
}

/**
 * Whether `winners` are the accounts and shares that `outcome` paid, in its order: those of a pick,
 * and none of a void. The outcome is the index's copy of the chain's, but it is read as JSON, so
 * the check does not lean on its shape.
 */
function samePayout(winners: Scorecard["winners"], outcome: TaskOutcome): boolean {
  const paid: unknown = outcome.kind === "picked" ? outcome.winners : [];
  if (!Array.isArray(paid) || paid.length !== winners.length) return false;
  return winners.every((winner, i) => {
    const payout = paid[i] as { account?: unknown; bps?: unknown } | null | undefined;
    return payout?.account === winner.account && payout?.bps === winner.bps;
  });
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

/** The columns of an `AgentSummary` for the agent row `a`, with `team` the team's accounts. */
function agentColumns(team: string): string {
  return `a.account,
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
    ${teamSql("a.account", team)} as is_team,
    a.status,
    a.bond_token,
    a.bond_amount::text as bond_amount,
    a.claimable_at::text as claimable_at`;
}

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
 * every database). An agent has `is_team` when it, or its provider, is one of `teamAccounts`.
 */
export async function listAgents(
  db: Db,
  f: AgentFilter,
  teamAccounts: readonly string[],
): Promise<ListAgentsResponse> {
  const limit = clampLimit(f.limit);
  const p = new SqlParams();
  const teamP = p.add([...teamAccounts]);
  const where: string[] = [];
  if (f.tag !== undefined) where.push(`a.tags @> ${p.add(JSON.stringify([f.tag]))}::jsonb`);
  if (f.asp !== undefined) where.push(`a.asp = ${p.add(f.asp)}`);
  if (f.cursor !== undefined) where.push(`a.account collate "C" > ${p.add(f.cursor)}`);

  const rows = await db.query<AgentSummary>(
    `select ${agentColumns(teamP)}
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
 * the account is no agent. It is labelled as `listAgents` labels it, by `teamAccounts`.
 */
export async function getAgentDetail(
  db: Db,
  account: string,
  now: bigint,
  teamAccounts: readonly string[],
): Promise<AgentDetailResponse | null> {
  const [agent] = await db.query<AgentSummary>(
    `select ${agentColumns("$2")} from agents a where a.account = $1`,
    [account, [...teamAccounts]],
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
 * The newest `MAX_LISTED` entries of `account`, newest commit first, with each task's phase at
 * `now`. An account that never entered a task has none, whether or not it is a registered agent.
 */
export async function listEntriesByAccount(
  db: Db,
  account: string,
  now: bigint,
): Promise<AccountEntriesResponse> {
  return { entries: await accountEntries(db, account, now, MAX_LISTED) };
}

async function accountEntries(
  db: Db,
  account: string,
  now: bigint,
  limit: number,
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
      limit ${p.add(limit)}::int`,
    p.values,
  );
}

// ---- Services ---------------------------------------------------------------------------------

/** A service row as the reads select it. */
interface ServiceRow {
  id: string;
  provider: string;
  agent: string;
  title: string;
  description: string;
  tags: string[];
  category: Service["category"];
  output_format: Service["output_format"];
  token: string;
  price: string;
  commit_secs: number;
  reveal_secs: number;
  pick_secs: number;
  verifier: "hirer" | "judge";
  criteria: string | null;
  status: Service["status"];
  created_at: Date;
  updated_at: Date;
  is_team: boolean;
}

/** The columns of a `ServiceRow` for the service row `s`, with `team` the team's accounts. */
function serviceColumns(team: string): string {
  return `s.id::text as id,
    s.provider,
    s.agent,
    s.title,
    s.description,
    s.tags,
    s.category,
    s.output_format,
    s.token,
    s.price::text as price,
    s.commit_secs,
    s.reveal_secs,
    s.pick_secs,
    s.verifier,
    s.criteria,
    s.status,
    s.created_at,
    s.updated_at,
    ${teamSql("s.agent", team)} as is_team`;
}

/**
 * Whether an agent can take a hire: it is active, and holds a bond. The contract lets an invited
 * account enter a pinned task whatever it is, and this is the API's own bar for a listing (the
 * brief's "an ACTIVE bonded agent"): an agent that is leaving, or never put a bond at stake, is not
 * offered for hire.
 */
export function canTakeHires(agent: Pick<AgentSummary, "status" | "bond_amount"> | null): boolean {
  return agent !== null && agent.status === "active" && agent.bond_amount != null;
}

/** The agent records of `accounts`, by account, as `getAgentDetail` reads one. */
async function agentRecords(
  db: Db,
  accounts: readonly string[],
  teamAccounts: readonly string[],
): Promise<Map<string, AgentSummary>> {
  if (accounts.length === 0) return new Map();
  const rows = await db.query<AgentSummary>(
    `select ${agentColumns("$2")} from agents a where a.account = any($1::text[])`,
    [[...new Set(accounts)], [...teamAccounts]],
  );
  return new Map(rows.map((row) => [row.account, row]));
}

/** A service as the API shows it, from its row and its agent's record. */
function serviceOf(row: ServiceRow, agent: AgentSummary | null): Service {
  const verification: Service["verification"] =
    row.verifier === "judge" && row.criteria !== null
      ? {
          kind: "judge",
          criteria: JSON.parse(row.criteria) as PublicCriteria,
          criteria_hash: sha256Hex(row.criteria),
        }
      : { kind: "hirer" };
  return {
    id: row.id,
    provider: row.provider,
    agent: row.agent,
    title: row.title,
    description: row.description,
    tags: row.tags,
    category: row.category,
    output_format: row.output_format,
    token: row.token,
    price: row.price,
    commit_secs: row.commit_secs,
    reveal_secs: row.reveal_secs,
    pick_secs: row.pick_secs,
    verification,
    status: row.status,
    available: row.status === "active" && canTakeHires(agent),
    is_team: row.is_team,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    agent_record: agent,
  };
}

async function servicesOf(
  db: Db,
  rows: ServiceRow[],
  teamAccounts: readonly string[],
): Promise<Service[]> {
  const agents = await agentRecords(
    db,
    rows.map((row) => row.agent),
    teamAccounts,
  );
  return rows.map((row) => serviceOf(row, agents.get(row.agent) ?? null));
}

export interface ServiceFilter {
  /** Words the title or the description contains, case aside: 1 to 80 characters. */
  q?: string;
  tag?: string;
  provider?: string;
  agent?: string;
  token?: string;
  /** A u128 as a decimal string: only prices at most this, in `token`. */
  maxPrice?: string;
  /** `available`: active services whose agent can take hires (`canTakeHires`). `all`: every one. */
  status: "available" | "all";
  /** Page size, from 1 to 50. */
  limit: number;
  /** A service id (a canonical u64): only services below it. */
  cursor?: string;
}

/** `text` for a `like` pattern that matches it as it is: `\`, `%` and `_` are escaped. */
function likeEscaped(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * The services that fit `f`, newest first, each with its agent's record from the index (the same
 * as `GET /v1/agents/:account` gives), labelled as ours when the team runs the agent or its
 * provider.
 */
export async function listServices(
  db: Db,
  f: ServiceFilter,
  teamAccounts: readonly string[],
): Promise<ListServicesResponse> {
  const limit = clampLimit(f.limit);
  const p = new SqlParams();
  const teamP = p.add([...teamAccounts]);
  const where: string[] = [];
  if (f.status === "available") {
    where.push(`s.status = 'active'`);
    where.push(
      "exists (select 1 from agents a where a.account = s.agent and a.status = 'active' and a.bond_amount is not null)",
    );
  }
  if (f.q !== undefined) {
    const pattern = p.add(`%${likeEscaped(f.q)}%`);
    where.push(
      `(s.title ilike ${pattern} escape '\\' or s.description ilike ${pattern} escape '\\')`,
    );
  }
  if (f.tag !== undefined) where.push(`s.tags @> ${p.add(JSON.stringify([f.tag]))}::jsonb`);
  if (f.provider !== undefined) where.push(`s.provider = ${p.add(f.provider)}`);
  if (f.agent !== undefined) where.push(`s.agent = ${p.add(f.agent)}`);
  if (f.token !== undefined) where.push(`s.token = ${p.add(f.token)}`);
  if (f.maxPrice !== undefined) where.push(`s.price <= ${p.add(f.maxPrice)}::numeric`);
  if (f.cursor !== undefined) where.push(`s.id < ${p.add(f.cursor)}::numeric`);

  const rows = await db.query<ServiceRow>(
    `select ${serviceColumns(teamP)}
       from services s
      ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
      order by s.id desc
      limit ${p.add(limit + 1)}::int`,
    p.values,
  );
  const { items, next_cursor } = pageOf(rows, limit, (last) => last.id);
  return { services: await servicesOf(db, items, teamAccounts), next_cursor };
}

/** One service, whatever its status, with its agent's record; null if there is no such service. */
export async function getService(
  db: Db,
  id: bigint,
  teamAccounts: readonly string[],
): Promise<Service | null> {
  const [row] = await db.query<ServiceRow>(
    `select ${serviceColumns("$2")} from services s where s.id = $1::numeric`,
    [id, [...teamAccounts]],
  );
  if (!row) return null;
  const [service] = await servicesOf(db, [row], teamAccounts);
  return service ?? null;
}
