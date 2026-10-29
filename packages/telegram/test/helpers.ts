import { type Db, migrate, openDb } from "@tender/db";

// Test data for the Telegram package: a migrated in-memory database, and one function per table
// that puts a row in it. Each seed fills every column the schema requires with a plausible value,
// so a test names only the columns it is about. This file has no tests, which is why it is not
// called `*.test.ts`: vitest would collect that name as a test file.
//
// Numbers the schema stores as `numeric` (task ids, amounts, deadlines in nanoseconds, heights)
// are decimal strings, as everywhere else. A `numeric` column that a seed does not mention is
// filled with a fixed value, and a nullable one stays null.

/** A Telegram chat id. Telegram's fit in 52 bits, so a number is exact; a bigint works too. */
export type ChatId = number | bigint;

/** A migrated, empty, in-memory database. The caller closes it. */
export async function openTestDb(): Promise<Db> {
  const db = await openDb("pglite:memory");
  try {
    await migrate(db);
  } catch (error) {
    await db.close();
    throw error;
  }
  return db;
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const NS_PER_HOUR = 3_600_000_000_000n;
/** 2026-10-29T00:00:00Z in nanoseconds, where a seeded task's clock starts. */
const START_NS = 1_793_232_000_000_000_000n;

/** The time `hours` after the start, as the contract writes a timestamp. */
function hoursAfterStart(hours: bigint): string {
  return (START_NS + hours * NS_PER_HOUR).toString();
}

/** Inserts one row. Table and column names are constants in this file, never test input. */
async function insertRow(db: Db, table: string, row: object): Promise<void> {
  const cells = Object.entries(row);
  const columns = cells.map(([column]) => column).join(", ");
  const marks = cells.map((_, i) => `$${i + 1}`).join(", ");
  // The database takes jsonb as JSON text: an array would go out as a Postgres array.
  const values = cells.map(([, value]) => (Array.isArray(value) ? JSON.stringify(value) : value));
  await db.query(`insert into ${table} (${columns}) values (${marks})`, values);
}

/** The columns of `tasks`, under their names in the database. */
export interface TaskColumns {
  id: string;
  poster: string;
  token: string;
  reward: string;
  fee_bps: number;
  brief_uri: string;
  brief_hash: string;
  criteria_hash: string;
  heldout_commitment: string | null;
  verifier: string;
  created_at: string;
  commit_deadline: string;
  reveal_deadline: string;
  pick_deadline: string;
  fallback_deadline: string;
  max_entries: number;
  max_winners: number;
  invited: string[];
  parent: string | null;
  commit_count: number;
  reveal_count: number;
  outcome: Record<string, unknown> | null;
  settled_height: string | null;
  title: string | null;
  category: string | null;
  tags: string[];
  judge_status: string | null;
  judge_reason: string | null;
  created_height: string;
}

/**
 * A task. Only `id` and `poster` are required. By default its windows run one hour each from the
 * start, it has no title and no tags, and the verifier is `judge.test`. It adds no `funders` row
 * for the poster, which the indexer does; seed that with `seedFunder`.
 */
export async function seedTask(
  db: Db,
  task: Pick<TaskColumns, "id" | "poster"> & Partial<TaskColumns>,
): Promise<void> {
  const row: TaskColumns = {
    token: "usdc.test",
    reward: "5000000",
    fee_bps: 500,
    brief_uri: `https://example.test/briefs/${task.id}`,
    brief_hash: HASH_A,
    criteria_hash: HASH_B,
    heldout_commitment: null,
    verifier: "judge.test",
    created_at: hoursAfterStart(0n),
    commit_deadline: hoursAfterStart(1n),
    reveal_deadline: hoursAfterStart(2n),
    pick_deadline: hoursAfterStart(3n),
    fallback_deadline: hoursAfterStart(4n),
    max_entries: 10,
    max_winners: 1,
    invited: [],
    parent: null,
    commit_count: 0,
    reveal_count: 0,
    outcome: null,
    settled_height: null,
    title: null,
    category: null,
    tags: [],
    judge_status: null,
    judge_reason: null,
    created_height: "1",
    ...task,
  };
  await insertRow(db, "tasks", row);
}

/** The columns of `entries`, under their names in the database. */
export interface EntryColumns {
  task_id: string;
  account: string;
  entry_index: number;
  commitment: string;
  committed_height: string;
  content_hash: string | null;
  uri: string | null;
}

/**
 * A sealed entry by `account`, numbered after the task's earlier entries. With `revealed: true` it
 * also has the content hash and URI that a `revealed` event fills in; without it both stay null,
 * as they do until the reveal. It does not touch the task's `commit_count` or `reveal_count`.
 */
export async function seedEntry(
  db: Db,
  taskId: string,
  account: string,
  {
    revealed = false,
    ...columns
  }: { revealed?: boolean } & Partial<Omit<EntryColumns, "task_id" | "account">> = {},
): Promise<void> {
  const earlier = await db.query<{ n: number }>(
    "select count(*)::int as n from entries where task_id = $1::numeric",
    [taskId],
  );
  await insertRow(db, "entries", {
    task_id: taskId,
    account,
    entry_index: earlier[0]?.n ?? 0,
    commitment: HASH_A,
    committed_height: "1",
    content_hash: revealed ? HASH_B : null,
    uri: revealed ? `https://example.test/results/${taskId}/${account}` : null,
    ...columns,
  });
}

/** One of a task's funders, with the amount it put in. */
export async function seedFunder(
  db: Db,
  taskId: string,
  account: string,
  amount = "1000000",
): Promise<void> {
  await insertRow(db, "funders", { task_id: taskId, account, amount });
}

/** The columns of `agents`, under their names in the database. */
export interface AgentColumns {
  account: string;
  asp: string | null;
  profile_uri: string;
  profile_hash: string;
  tags: string[];
  name: string | null;
  entries: number;
  reveals: number;
  wins: number;
  earned: Record<string, string>;
  picks_made: number;
  voids_after_reveals: number;
  registered_height: string;
  is_team: boolean;
}

/**
 * A registered agent. It has no ASP unless `asp` is given, no tags, and its counters at the
 * database's default, 0.
 */
export async function seedAgent(
  db: Db,
  account: string,
  columns: Partial<Omit<AgentColumns, "account">> = {},
): Promise<void> {
  await insertRow(db, "agents", {
    account,
    asp: null,
    profile_uri: `https://example.test/agents/${account}.json`,
    profile_hash: HASH_C,
    tags: [],
    registered_height: "1",
    ...columns,
  });
}

/** A chat linked to `account`, as `/start <nonce>` leaves it. */
export async function linkChat(
  db: Db,
  chatId: ChatId,
  account: string,
  { muted = false }: { muted?: boolean } = {},
): Promise<void> {
  await insertRow(db, "tg_links", { chat_id: chatId, account, muted });
}

/** A chat watching `tag`, as `/watch <tag>` leaves it. */
export async function watchTag(db: Db, chatId: ChatId, tag: string): Promise<void> {
  await insertRow(db, "tg_watches", { chat_id: chatId, tag });
}
