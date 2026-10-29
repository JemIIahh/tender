import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type BlobKind,
  type Db,
  getBlob,
  migrate,
  openDb,
  putBlob,
  setBlobPublic,
} from "../src/index";

// Every test here runs on PGlite. The db suite also runs on a real Postgres when TEST_DATABASE_URL
// is set (a direct connection, not a transaction pooler: each database gets its own schema through
// the `options` startup parameter). CI and the dev machine have no Postgres server, so that half
// is opt-in; the "fake pool" tests below are what covers the pg driver code without one.
const POSTGRES_URL = process.env.TEST_DATABASE_URL || undefined;

const U128_MAX = "340282366920938463463374607431768211455";
const MINUTE = { timeout: 60_000 };

interface Fresh {
  db: Db;
  dispose(): Promise<void>;
}
interface Target {
  name: string;
  /** A new, empty, unmigrated database. */
  fresh(): Promise<Fresh>;
}

const pgliteTarget: Target = {
  name: "pglite",
  async fresh() {
    const db = await openDb("pglite:memory");
    return { db, dispose: () => db.close() };
  },
};

/** Each Postgres database lives in its own schema, so runs never see each other's tables. */
function postgresTarget(url: string): Target {
  return {
    name: "postgres",
    async fresh() {
      const schema = `t_${randomBytes(6).toString("hex")}`;
      const admin = await openDb(url);
      await admin.exec(`create schema ${schema}`);
      const scoped = new URL(url);
      scoped.searchParams.set("options", `-c search_path=${schema}`);
      const db = await openDb(scoped.toString()).catch(async (error: unknown) => {
        await admin.exec(`drop schema ${schema} cascade`);
        await admin.close();
        throw error;
      });
      return {
        db,
        async dispose() {
          await db.close();
          await admin.exec(`drop schema ${schema} cascade`);
          await admin.close();
        },
      };
    },
  };
}

const targets = POSTGRES_URL ? [pgliteTarget, postgresTarget(POSTGRES_URL)] : [pgliteTarget];

/** Inserts one row; table and column names are test constants. */
async function insertRow(db: Db, table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  const marks = columns.map((_, i) => `$${i + 1}`).join(", ");
  await db.query(
    `insert into ${table} (${columns.join(", ")}) values (${marks})`,
    Object.values(row),
  );
}

// The brief's schema in the brief's words, one entry per column, in column order.
// "?" marks a nullable column; "= x" is its default. Types are what Postgres prints.
const SCHEMA: Record<string, string[]> = {
  schema_migrations: ["name text", "applied_at timestamp with time zone? = now()"],
  chain_cursor: ["source text", "height numeric(40,0)"],
  events: [
    "id bigint = serial",
    "height numeric(40,0)",
    "block_ts numeric(40,0)",
    "receipt_id text",
    "log_index integer",
    "event text",
    "data jsonb",
    "task_id numeric(40,0)?",
  ],
  tasks: [
    "id numeric(40,0)",
    "poster text",
    "token text",
    "reward numeric(40,0)",
    "fee_bps integer",
    "brief_uri text",
    "brief_hash text",
    "criteria_hash text",
    "heldout_commitment text?",
    "verifier text",
    "created_at numeric(40,0)",
    "commit_deadline numeric(40,0)",
    "reveal_deadline numeric(40,0)",
    "pick_deadline numeric(40,0)",
    "fallback_deadline numeric(40,0)",
    "max_entries integer",
    "max_winners integer",
    "invited jsonb",
    "parent numeric(40,0)?",
    "commit_count integer = 0",
    "reveal_count integer = 0",
    "outcome jsonb?",
    "settled_height numeric(40,0)?",
    "title text?",
    "category text?",
    "tags jsonb = '[]'::jsonb",
    "judge_status text?",
    "judge_reason text?",
    "created_height numeric(40,0)",
  ],
  funders: ["task_id numeric(40,0)", "account text", "amount numeric(40,0)"],
  entries: [
    "task_id numeric(40,0)",
    "account text",
    "entry_index integer",
    "commitment text",
    "committed_height numeric(40,0)",
    "content_hash text?",
    "uri text?",
  ],
  agents: [
    "account text",
    "asp text?",
    "profile_uri text",
    "profile_hash text",
    "tags jsonb",
    "name text?",
    "entries integer = 0",
    "reveals integer = 0",
    "wins integer = 0",
    "earned jsonb = '{}'::jsonb",
    "picks_made integer = 0",
    "voids_after_reveals integer = 0",
    "registered_height numeric(40,0)",
    "is_team boolean = false",
  ],
  blobs: [
    "sha256 text",
    "kind text",
    "content_type text",
    "bytes bytea",
    "task_id numeric(40,0)?",
    "uploader text?",
    "is_public boolean",
    "created_at timestamp with time zone = now()",
  ],
  working: ["task_id numeric(40,0)", "account text", "started_at timestamp with time zone = now()"],
  auth_challenges: ["nonce text", "expires_at timestamp with time zone", "used boolean = false"],
  auth_tokens: [
    "token_sha256 text",
    "account text",
    "public_key text",
    "key_kind text",
    "expires_at timestamp with time zone",
  ],
  tg_links: [
    "chat_id bigint",
    "account text",
    "muted boolean = false",
    "linked_at timestamp with time zone = now()",
  ],
  tg_link_nonces: [
    "nonce text",
    "account text",
    "expires_at timestamp with time zone",
    "used boolean = false",
  ],
  tg_watches: ["chat_id bigint", "tag text"],
  tg_sent: ["chat_id bigint", "dedupe_key text", "sent_at timestamp with time zone = now()"],
  worker_cursor: ["name text", "event_id bigint"],
};

// Primary keys, uniqueness and the four task indexes, as "table: kind (columns)".
const KEYS = [
  "agents: primary key (account)",
  "auth_challenges: primary key (nonce)",
  "auth_tokens: primary key (token_sha256)",
  "blobs: primary key (sha256)",
  "chain_cursor: primary key (source)",
  "entries: primary key (task_id, account)",
  "events: index (task_id)",
  "events: primary key (id)",
  "events: unique (receipt_id, log_index)",
  "funders: primary key (task_id, account)",
  "schema_migrations: primary key (name)",
  "tasks: index (commit_deadline)",
  "tasks: primary key (id)",
  "tasks: index (parent)",
  "tasks: index (poster)",
  "tasks: index (verifier)",
  "tg_link_nonces: primary key (nonce)",
  "tg_links: primary key (chat_id)",
  "tg_sent: primary key (chat_id, dedupe_key)",
  "tg_watches: primary key (chat_id, tag)",
  "worker_cursor: primary key (name)",
  "working: primary key (task_id, account)",
].sort();

// Every constraint that is not a key (those are in KEYS) and not NOT NULL (that is the "?" above;
// Postgres 18 also lists NOT NULL in pg_constraint, 17 does not): no foreign key, no other CHECK.
const CONSTRAINTS = [
  "blobs: CHECK ((kind = ANY (ARRAY['brief'::text, 'criteria'::text, 'heldout'::text, " +
    "'result'::text, 'scorecard'::text, 'profile'::text])))",
];

async function describeSchema(db: Db) {
  const columns = await db.query<{
    tbl: string;
    col: string;
    type: string;
    notnull: boolean;
    dflt: string | null;
  }>(
    `select c.relname as tbl, a.attname as col, format_type(a.atttypid, a.atttypmod) as type,
            a.attnotnull as notnull, pg_get_expr(d.adbin, d.adrelid) as dflt
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid and c.relkind = 'r'
       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where c.relnamespace = current_schema()::regnamespace and a.attnum > 0 and not a.attisdropped
      order by c.relname, a.attnum`,
  );
  const tables: Record<string, string[]> = {};
  for (const { tbl, col, type, notnull, dflt } of columns) {
    const def = dflt === null ? "" : ` = ${dflt.startsWith("nextval(") ? "serial" : dflt}`;
    const lines = tables[tbl] ?? [];
    lines.push(`${col} ${type}${notnull ? "" : "?"}${def}`);
    tables[tbl] = lines;
  }
  const keyRows = await db.query<{ tbl: string; pk: boolean; uniq: boolean; cols: string }>(
    `select c.relname as tbl, i.indisprimary as pk, i.indisunique as uniq,
            (select string_agg(a.attname, ', ' order by k.ord)
               from unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
               join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) as cols
       from pg_index i join pg_class c on c.oid = i.indrelid
      where c.relnamespace = current_schema()::regnamespace`,
  );
  const keys = keyRows
    .map((k) => `${k.tbl}: ${k.pk ? "primary key" : k.uniq ? "unique" : "index"} (${k.cols})`)
    .sort();
  const constraintRows = await db.query<{ tbl: string; def: string }>(
    `select c.relname as tbl, pg_get_constraintdef(k.oid) as def
       from pg_constraint k join pg_class c on c.oid = k.conrelid
      where k.connamespace = current_schema()::regnamespace and k.contype not in ('p', 'u', 'n')`,
  );
  const constraints = constraintRows.map((k) => `${k.tbl}: ${k.def}`).sort();
  return { tables, keys, constraints };
}

// What the drivers must hand back, whichever one is underneath. Every numeric and bigint is text.
async function probeRows(db: Db) {
  const [literals] = await db.query(
    `select 340282366920938463463374607431768211455::numeric(40,0) as numeric_value,
            9007199254740993::bigint as bigint_value,
            array[340282366920938463463374607431768211455::numeric, 1::numeric] as numeric_array_value,
            array[9007199254740993::bigint, 1::bigint, null] as int8_array_value,
            7::int as int_value, 1.5::float8 as float_value, true as bool_value,
            '{"a":[1,"x",null]}'::jsonb as jsonb_value,
            '\\x00ff10'::bytea as bytea_value,
            timestamptz '2026-10-29 12:00:00+00' as timestamptz_value,
            null::text as null_value`,
  );

  // A realistic task: bigint and string parameters for numeric columns, JSON text and an object
  // for jsonb, undefined for a nullable column, and defaults for the rest.
  await insertRow(db, "tasks", {
    id: 2n ** 64n - 1n,
    poster: "poster.test.near",
    token: "token.test.near",
    reward: BigInt(U128_MAX),
    fee_bps: 500,
    brief_uri: "ipfs://brief",
    brief_hash: "29a8825bd242f14386ee528d76e0e8f1e38f3c8c4047d7b2d6df7493368a17d0",
    criteria_hash: "262d517bffd06484e2341b4a379c7f4fa4be9284a9a82631c03420953d60bd67",
    heldout_commitment: undefined,
    verifier: "judge.test.near",
    created_at: "1793307169820229000",
    commit_deadline: 1793307289820229000n,
    reveal_deadline: 1793307409820229000n,
    pick_deadline: 1793307529820229000n,
    fallback_deadline: 1793307649820229000n,
    max_entries: 2,
    max_winners: 2,
    invited: JSON.stringify(["alice.test.near", "bob.test.near"]),
    outcome: { kind: "picked", fee: 50000n, winners: [{ account: "alice.test.near", bps: 7000 }] },
    created_height: 9007199254740993n,
  });
  const [task] = await db.query("select * from tasks where id = $1", [2n ** 64n - 1n]);

  await insertRow(db, "events", {
    height: 65n,
    block_ts: 1793307169820229000n,
    receipt_id: "receipt-probe",
    log_index: 0,
    event: "task_created",
    data: { id: "1", reward: "1000003" },
    task_id: 1n,
  });
  const [event] = await db.query("select * from events where receipt_id = 'receipt-probe'");

  await insertRow(db, "tg_links", {
    chat_id: -1001234567890123456n,
    account: "alice.test.near",
    linked_at: new Date("2026-10-29T12:00:00Z"),
  });
  const [link] = await db.query("select * from tg_links where account = 'alice.test.near'");

  return { literals, task, event, link };
}

const EXPECTED_PROBE = {
  literals: {
    numeric_value: U128_MAX,
    bigint_value: "9007199254740993",
    numeric_array_value: [U128_MAX, "1"],
    int8_array_value: ["9007199254740993", "1", null],
    int_value: 7,
    float_value: 1.5,
    bool_value: true,
    jsonb_value: { a: [1, "x", null] },
    bytea_value: Uint8Array.of(0, 255, 16),
    timestamptz_value: new Date("2026-10-29T12:00:00Z"),
    null_value: null,
  },
  task: {
    id: "18446744073709551615",
    poster: "poster.test.near",
    token: "token.test.near",
    reward: U128_MAX,
    fee_bps: 500,
    brief_uri: "ipfs://brief",
    brief_hash: "29a8825bd242f14386ee528d76e0e8f1e38f3c8c4047d7b2d6df7493368a17d0",
    criteria_hash: "262d517bffd06484e2341b4a379c7f4fa4be9284a9a82631c03420953d60bd67",
    heldout_commitment: null,
    verifier: "judge.test.near",
    created_at: "1793307169820229000",
    commit_deadline: "1793307289820229000",
    reveal_deadline: "1793307409820229000",
    pick_deadline: "1793307529820229000",
    fallback_deadline: "1793307649820229000",
    max_entries: 2,
    max_winners: 2,
    invited: ["alice.test.near", "bob.test.near"],
    parent: null,
    commit_count: 0,
    reveal_count: 0,
    // A bigint inside a JSON parameter is written as a decimal string.
    outcome: { kind: "picked", fee: "50000", winners: [{ account: "alice.test.near", bps: 7000 }] },
    settled_height: null,
    title: null,
    category: null,
    tags: [],
    judge_status: null,
    judge_reason: null,
    created_height: "9007199254740993",
  },
  event: {
    id: expect.stringMatching(/^\d+$/), // a bigserial: text, whatever number it has reached
    height: "65",
    block_ts: "1793307169820229000",
    receipt_id: "receipt-probe",
    log_index: 0,
    event: "task_created",
    data: { id: "1", reward: "1000003" },
    task_id: "1",
  },
  link: {
    chat_id: "-1001234567890123456",
    account: "alice.test.near",
    muted: false,
    linked_at: new Date("2026-10-29T12:00:00Z"),
  },
};

describe.each(targets)("db on $name", (target) => {
  let fresh: Fresh;
  let db: Db;

  beforeAll(async () => {
    fresh = await target.fresh();
    db = fresh.db;
    await migrate(db);
  }, 60_000);

  afterAll(async () => {
    await fresh?.dispose();
  }, 60_000);

  it("migrate_is_idempotent", MINUTE, async () => {
    const { db: empty, dispose } = await target.fresh();
    try {
      // Two services starting together apply the migration once between them.
      const concurrent = await Promise.all([migrate(empty), migrate(empty)]);
      expect(concurrent.map((applied) => applied.length).sort()).toEqual([0, 1]);
      expect(concurrent.flat()).toEqual(["0001_init.sql"]);
      expect(await migrate(empty)).toEqual([]);
      const recorded = await empty.query("select name, applied_at from schema_migrations");
      expect(recorded).toEqual([{ name: "0001_init.sql", applied_at: expect.any(Date) }]);
    } finally {
      await dispose();
    }
  });

  it("migrations_run_in_name_order_and_a_failure_leaves_no_trace", MINUTE, async () => {
    const dir = await mkdtemp(join(tmpdir(), "tender-migrations-"));
    const { db: scratch, dispose } = await target.fresh();
    try {
      await writeFile(
        join(dir, "0002_second.sql"),
        "create table m_two (n int); insert into m_two values (2);",
      );
      await writeFile(
        join(dir, "0001_first.sql"),
        "create table m_one (n int); insert into m_one values (1);",
      );
      await writeFile(join(dir, "notes.txt"), "not a migration");
      expect(await migrate(scratch, dir)).toEqual(["0001_first.sql", "0002_second.sql"]);

      // The third file creates a table and then fails: neither the table nor a record may remain.
      await writeFile(
        join(dir, "0003_broken.sql"),
        "create table m_three (n int); select * from nope;",
      );
      await expect(migrate(scratch, dir)).rejects.toThrow(/0003_broken\.sql/);
      expect(await scratch.query("select to_regclass('m_three')::text as found")).toEqual([
        { found: null },
      ]);
      const names = await scratch.query<{ name: string }>(
        "select name from schema_migrations order by name",
      );
      expect(names.map((r) => r.name)).toEqual(["0001_first.sql", "0002_second.sql"]);

      // Fixing the file lets the next run pick it up.
      await writeFile(join(dir, "0003_broken.sql"), "create table m_three (n int);");
      expect(await migrate(scratch, dir)).toEqual(["0003_broken.sql"]);
    } finally {
      await dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("schema_matches_the_brief", async () => {
    const { tables, keys, constraints } = await describeSchema(db);
    expect(tables).toEqual(SCHEMA);
    expect(keys).toEqual(KEYS);
    expect(constraints).toEqual(CONSTRAINTS);
  });

  it("numeric_round_trips_as_text", async () => {
    await insertRow(db, "chain_cursor", { source: "u128-text", height: U128_MAX });
    await insertRow(db, "chain_cursor", { source: "u128-bigint", height: BigInt(U128_MAX) });
    const rows = await db.query<{ source: string; height: string }>(
      "select source, height::text as height from chain_cursor where source like 'u128-%' order by source",
    );
    expect(rows).toEqual([
      { source: "u128-bigint", height: U128_MAX },
      { source: "u128-text", height: U128_MAX },
    ]);
    expect(rows.map((r) => BigInt(r.height))).toEqual([2n ** 128n - 1n, 2n ** 128n - 1n]);

    // Nanosecond timestamps and 64-bit integers past 2^53 survive as well, and so does the sign.
    await insertRow(db, "events", {
      height: 1n,
      block_ts: 1793307169820229000n,
      receipt_id: "ns-timestamp",
      log_index: 0,
      event: "deposit",
      data: {},
    });
    await insertRow(db, "tg_links", { chat_id: -(2n ** 53n) - 1n, account: "bigint.near" });
    await insertRow(db, "worker_cursor", { name: "bigint", event_id: 2n ** 63n - 1n });
    expect(
      await db.query("select block_ts::text as v from events where receipt_id = 'ns-timestamp'"),
    ).toEqual([{ v: "1793307169820229000" }]);
    expect(
      await db.query("select chat_id::text as v from tg_links where account = 'bigint.near'"),
    ).toEqual([{ v: "-9007199254740993" }]);
    expect(
      await db.query("select event_id::text as v from worker_cursor where name = 'bigint'"),
    ).toEqual([{ v: "9223372036854775807" }]);

    // Even without the cast, no driver turns a numeric into a lossy JS number.
    expect(await db.query("select height from chain_cursor where source = 'u128-text'")).toEqual([
      { height: U128_MAX },
    ]);
  });

  it("row_shapes_match_contract", async () => {
    expect(await probeRows(db)).toStrictEqual(EXPECTED_PROBE);
  });

  it("arrays_bind_as_sql_arrays_and_jsonb_takes_json_text", async () => {
    await insertRow(db, "chain_cursor", { source: "any-a", height: 1n });
    await insertRow(db, "chain_cursor", { source: "any-b", height: 2n });
    await insertRow(db, "chain_cursor", { source: "any-c", height: 3n });

    // A list for = any(...) is a Postgres array, as in node-postgres: of text, and of bigint.
    expect(
      await db.query("select source from chain_cursor where source = any($1) order by source", [
        ["any-a", "any-c"],
      ]),
    ).toEqual([{ source: "any-a" }, { source: "any-c" }]);
    expect(
      await db.query(
        "select source from chain_cursor where height = any($1) and source like 'any-%' order by source",
        [[2n, 3n]],
      ),
    ).toEqual([{ source: "any-b" }, { source: "any-c" }]);

    // A list for a jsonb column is JSON text. A raw array is refused, here and on Postgres.
    expect(await db.query("select $1::jsonb as list", [JSON.stringify(["a", "b"])])).toEqual([
      { list: ["a", "b"] },
    ]);
    await expect(db.query("select $1::jsonb as list", [["a", "b"]])).rejects.toThrow();
    // An object is JSON; a bigint inside it is written as text, never as a lossy number.
    expect(await db.query("select $1::jsonb as obj", [{ amount: 2n ** 70n, list: [1] }])).toEqual([
      { obj: { amount: "1180591620717411303424", list: [1] } },
    ]);
  });

  it("query_runs_one_statement_and_exec_runs_scripts", async () => {
    await db.exec(
      "insert into chain_cursor values ('script-a', 1); insert into chain_cursor values ('script-b', 2)",
    );
    expect(
      await db.query(
        "select source from chain_cursor where source like 'script-%' order by source",
      ),
    ).toEqual([{ source: "script-a" }, { source: "script-b" }]);
    await expect(db.query("select 1; select 2")).rejects.toThrow();
    // A script that fails half way leaves nothing behind.
    await expect(
      db.exec("insert into chain_cursor values ('script-c', 3); select * from does_not_exist"),
    ).rejects.toThrow();
    expect(await db.query("select 1 from chain_cursor where source = 'script-c'")).toEqual([]);
  });

  it("tx_rolls_back_on_throw", { timeout: 30_000 }, async () => {
    const count = async (source: string) =>
      (await db.query("select 1 from chain_cursor where source = $1", [source])).length;

    await expect(
      db.tx(async (tx) => {
        await tx.query("insert into chain_cursor (source, height) values ($1, $2)", [
          "tx-throw",
          1n,
        ]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await count("tx-throw")).toBe(0);

    // A failing statement undoes the earlier ones too, and leaves the database usable.
    await expect(
      db.tx(async (tx) => {
        await tx.query("insert into chain_cursor (source, height) values ($1, $2)", [
          "tx-sql-error",
          1n,
        ]);
        await tx.query(
          "insert into blobs (sha256, kind, content_type, bytes, is_public) values ('x', 'bad', 'x', $1, true)",
          [Uint8Array.of(1)],
        );
      }),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await count("tx-sql-error")).toBe(0);

    // Failed transactions give their connection back: more of them than any pool holds still run.
    for (let i = 0; i < 12; i++) {
      await expect(
        db.tx(async () => {
          throw new Error(`failure ${i}`);
        }),
      ).rejects.toThrow(`failure ${i}`);
    }

    // The success path commits and returns the callback's value.
    const returned = await db.tx(async (tx) => {
      await tx.query("insert into chain_cursor (source, height) values ($1, $2)", [
        "tx-commit",
        7n,
      ]);
      return "done";
    });
    expect(returned).toBe("done");
    expect(await count("tx-commit")).toBe(1);

    // A handle kept past its transaction is dead; it must not run on a connection somebody else holds.
    const kept: Db[] = [];
    await db.tx(async (tx) => {
      kept.push(tx);
    });
    await expect(kept[0]?.query("select 1")).rejects.toThrow("transaction is closed");
    await expect(kept[0]?.exec("select 1")).rejects.toThrow("transaction is closed");
    await expect(kept[0]?.close()).rejects.toThrow();
    expect(await db.query("select 1 as one")).toEqual([{ one: 1 }]);
  });

  it("nested_tx_rolls_back_only_the_inner_work", async () => {
    const sources = async () =>
      (
        await db.query<{ source: string }>(
          "select source from chain_cursor where source like 'nested-%' order by source",
        )
      ).map((r) => r.source);
    const insert = (tx: Db, source: string) =>
      tx.query("insert into chain_cursor (source, height) values ($1, $2)", [source, 1n]);

    await db.tx(async (tx) => {
      await insert(tx, "nested-outer");
      await expect(
        tx.tx(async (inner) => {
          await insert(inner, "nested-inner-fails");
          throw new Error("inner boom");
        }),
      ).rejects.toThrow("inner boom");
      await tx.tx((inner) => insert(inner, "nested-inner-ok"));
    });
    expect(await sources()).toEqual(["nested-inner-ok", "nested-outer"]);
  });

  it("nested_tx_survives_a_failed_statement", async () => {
    const sources = async () =>
      (
        await db.query<{ source: string }>(
          "select source from chain_cursor where source like 'nested-sql-%' order by source",
        )
      ).map((r) => r.source);
    const insert = (tx: Db, source: string) =>
      tx.query("insert into chain_cursor (source, height) values ($1, $2)", [source, 1n]);

    await db.tx(async (tx) => {
      await insert(tx, "nested-sql-outer");
      // A statement the database rejects, not just a callback that throws: Postgres refuses every
      // later command of the transaction until the savepoint has been rolled back.
      await expect(
        tx.tx(async (inner) => {
          await insert(inner, "nested-sql-inner");
          await insert(inner, "nested-sql-outer");
        }),
      ).rejects.toMatchObject({ code: "23505" });
      await insert(tx, "nested-sql-after");
    });
    expect(await sources()).toEqual(["nested-sql-after", "nested-sql-outer"]);
  });

  it("unsafe_integers_are_refused_not_rounded", async () => {
    // No JS number holds these exactly, so the digits that would be sent are not the digits meant.
    for (const n of [2 ** 53, -(2 ** 53), 2 ** 60, 1e21, Number.MAX_VALUE]) {
      await expect(db.query("select $1::numeric as n", [n])).rejects.toThrow(RangeError);
    }
    await expect(db.query("select $1::int as a, $2::numeric as b", [1, 2 ** 60])).rejects.toThrow(
      /\$2/,
    );
    await expect(db.tx((tx) => tx.query("select $1::numeric as n", [2 ** 60]))).rejects.toThrow(
      /\$1/,
    );
    // Inside a list for = any($1), and inside a JSON object.
    await expect(db.query("select $1::numeric[] as n", [[1, 2 ** 60]])).rejects.toThrow(RangeError);
    await expect(db.query("select $1::jsonb as n", [{ fee: { amount: 2 ** 60 } }])).rejects.toThrow(
      RangeError,
    );

    // What a number does hold exactly goes through; a bigint or decimal text is the way for the rest.
    expect(await db.query("select $1::numeric::text as n", [Number.MAX_SAFE_INTEGER])).toEqual([
      { n: "9007199254740991" },
    ]);
    expect(await db.query("select $1::numeric::text as n", [Number.MIN_SAFE_INTEGER])).toEqual([
      { n: "-9007199254740991" },
    ]);
    expect(await db.query("select $1::float8 as n", [1.5])).toEqual([{ n: 1.5 }]);
    expect(await db.query("select $1::numeric::text as n", [2n ** 60n])).toEqual([
      { n: "1152921504606846976" },
    ]);
    expect(await db.query("select $1::numeric::text as n", ["1152921504606846977"])).toEqual([
      { n: "1152921504606846977" },
    ]);
    expect(await db.query("select $1::jsonb as n", [{ fee: 7 }])).toEqual([{ n: { fee: 7 } }]);
  });

  it("errors_carry_no_statement_or_parameters", async () => {
    // PGlite attaches the statement and its parameters to every error it throws, and an error is
    // what gets logged. The parameters can be blob bytes or a held-out answer.
    const insert =
      "insert into blobs (sha256, kind, content_type, bytes, is_public) values ('scrub', 'bad', 'x', $1, true)";
    const secret = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
    const attempts = [
      () => db.query(insert, [secret]),
      () => db.tx((tx) => tx.query(insert, [secret])),
      () => db.tx((tx) => tx.tx((inner) => inner.query(insert, [secret]))),
      () => db.exec(insert.replace("$1", "'\\xdeadbeef'")),
    ];
    for (const attempt of attempts) {
      const error = await attempt().then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(Error);
      // The diagnosis stays: the message, the SQLSTATE and the constraint.
      expect((error as Error).message).toContain("violates check constraint");
      expect(error).toHaveProperty("code", "23514");
      expect(error).toHaveProperty("constraint", "blobs_kind_check");
      for (const property of ["query", "params", "queryOptions"]) {
        expect(error).not.toHaveProperty(property);
      }
    }

    const syntax = await db.query("selec 1").then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(syntax).toHaveProperty("code", "42601");
    expect(syntax).not.toHaveProperty("query");
    expect(syntax).not.toHaveProperty("params");
  });

  it("blobs_put_get_idempotent", async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const sha = await putBlob(db, {
      kind: "brief",
      contentType: "application/octet-stream",
      bytes,
      taskId: 2n ** 64n - 1n,
      uploader: "alice.near",
      isPublic: false,
    });
    expect(sha).toBe(createHash("sha256").update(bytes).digest("hex"));

    const stored = await getBlob(db, sha);
    expect(stored).toEqual({
      kind: "brief",
      contentType: "application/octet-stream",
      bytes,
      taskId: "18446744073709551615",
      uploader: "alice.near",
      isPublic: false,
    });
    expect(stored?.bytes.constructor).toBe(Uint8Array);

    // The same bytes again, with other metadata: same sha, and the stored row is left as it was.
    // In particular a second, public upload can not expose a private blob.
    const again = await putBlob(db, {
      kind: "result",
      contentType: "text/plain",
      bytes,
      isPublic: true,
    });
    expect(again).toBe(sha);
    expect(await getBlob(db, sha)).toEqual(stored);
    expect(
      await db.query("select count(*)::text as n from blobs where sha256 = $1", [sha]),
    ).toEqual([{ n: "1" }]);

    // Known answer, no task and no uploader.
    const abc = await putBlob(db, {
      kind: "profile",
      contentType: "text/plain",
      bytes: new TextEncoder().encode("abc"),
      isPublic: true,
    });
    expect(abc).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await getBlob(db, abc)).toMatchObject({ taskId: null, uploader: null, isPublic: true });

    // Empty content is a blob, and a view into a larger buffer is stored as just its own bytes.
    const empty = await putBlob(db, {
      kind: "result",
      contentType: "text/plain",
      bytes: new Uint8Array(),
      isPublic: true,
    });
    expect((await getBlob(db, empty))?.bytes).toEqual(new Uint8Array());
    const window = new Uint8Array([9, 9, 1, 2, 3, 9, 9]).subarray(2, 5);
    const viewSha = await putBlob(db, {
      kind: "result",
      contentType: "text/plain",
      bytes: window,
      isPublic: true,
    });
    expect((await getBlob(db, viewSha))?.bytes).toEqual(Uint8Array.of(1, 2, 3));

    expect(await getBlob(db, "0".repeat(64))).toBeNull();

    // Visibility changes only through setBlobPublic; an unknown hash is not an error.
    await setBlobPublic(db, sha, true);
    expect((await getBlob(db, sha))?.isPublic).toBe(true);
    await setBlobPublic(db, sha, false);
    expect((await getBlob(db, sha))?.isPublic).toBe(false);
    await expect(setBlobPublic(db, "0".repeat(64), true)).resolves.toBeUndefined();
  });

  it("blob_kind_checked", async () => {
    const kinds: BlobKind[] = ["brief", "criteria", "heldout", "result", "scorecard", "profile"];
    for (const [i, kind] of kinds.entries()) {
      const sha = await putBlob(db, {
        kind,
        contentType: "text/plain",
        bytes: Uint8Array.of(100, i),
        isPublic: true,
      });
      expect((await getBlob(db, sha))?.kind).toBe(kind);
    }

    const bad = Uint8Array.of(200, 1, 2, 3);
    await expect(
      putBlob(db, {
        kind: "nonsense" as BlobKind,
        contentType: "text/plain",
        bytes: bad,
        isPublic: true,
      }),
    ).rejects.toMatchObject({ code: "23514" });
    // The table itself enforces it, not only putBlob.
    await expect(
      db.query(
        "insert into blobs (sha256, kind, content_type, bytes, is_public) values ($1, 'nonsense', 'x', $2, true)",
        ["ab".repeat(32), bad],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await getBlob(db, createHash("sha256").update(bad).digest("hex"))).toBeNull();
    expect(await getBlob(db, "ab".repeat(32))).toBeNull();
  });
});

describe("openDb", () => {
  it("unsupported_urls_are_refused_without_echoing_them", async () => {
    const attempts = ["mysql://user:hunter2@host/db", "hunter2", "pglite:", ""];
    for (const url of attempts) {
      const failure = await openDb(url).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(String((failure as Error).message)).not.toContain("hunter2");
    }
    await expect(openDb("mysql://user:hunter2@host/db")).rejects.toThrow(
      /unsupported database url/,
    );
  });

  it("pglite_directory_keeps_its_data", MINUTE, async () => {
    const base = await mkdtemp(join(tmpdir(), "tender-pglite-"));
    const url = `pglite:${join(base, "nested", "data")}`;
    try {
      const first = await openDb(url);
      expect(await migrate(first)).toEqual(["0001_init.sql"]);
      const sha = await putBlob(first, {
        kind: "brief",
        contentType: "text/plain",
        bytes: Uint8Array.of(5, 6, 7),
        isPublic: true,
      });
      await first.close();
      await first.close(); // closing twice is harmless

      const second = await openDb(url);
      expect(await migrate(second)).toEqual([]);
      expect((await getBlob(second, sha))?.bytes).toEqual(Uint8Array.of(5, 6, 7));
      await second.close();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// Needs a Postgres server to be a real test of the driver; that is what TEST_DATABASE_URL is for.
// This block replaces the Pool's methods, so it can only check how the adapter drives a
// connection: BEGIN/COMMIT/ROLLBACK order, and that every connection goes back to the pool.
describe("postgres adapter against a fake pool", () => {
  afterEach(() => vi.restoreAllMocks());

  function fakePool(failOn?: RegExp, dropOn?: RegExp) {
    const log: string[] = [];
    const queries: unknown[] = [];
    const pools: pg.Pool[] = [];
    // What an 'error' event threw because nobody was listening. In production that is an uncaught
    // exception, and it ends the process.
    const uncaught: unknown[] = [];
    const release = vi.fn();
    let dead = false;
    // pg emits 'error' on a dead client from its socket handler, where nothing up the stack can
    // catch what the emit throws, so the fake catches it here and keeps it.
    const socketError = (error: Error) => {
      dead = true;
      try {
        client.emit("error", error);
      } catch (thrown) {
        uncaught.push(thrown);
      }
    };
    // A pg client is an EventEmitter. pg-pool takes its own 'error' listener off a client while it
    // is checked out, so this one starts with none, as in production.
    const client = Object.assign(new EventEmitter(), {
      query: async (q: string | { text: string }) => {
        const text = typeof q === "string" ? q : q.text;
        log.push(text);
        if (dead) throw new Error("Client has encountered a connection error and is not queryable");
        if (failOn?.test(text)) throw new Error(`fake failure on: ${text}`);
        if (dropOn?.test(text)) {
          // As in pg: the statement fails, and the client emits 'error' before the caller has
          // seen the failure.
          const lost = new Error("Connection terminated unexpectedly");
          dead = true;
          queueMicrotask(() => socketError(lost));
          throw lost;
        }
        return { rows: [] };
      },
      release,
    });
    vi.spyOn(pg.Pool.prototype, "connect").mockImplementation((async () => client) as never);
    vi.spyOn(pg.Pool.prototype, "query").mockImplementation(function (
      this: pg.Pool,
      query: unknown,
    ) {
      pools.push(this);
      queries.push(query);
      return Promise.resolve({ rows: [] });
    } as never);
    const end = vi.spyOn(pg.Pool.prototype, "end").mockImplementation((async () => {}) as never);
    return { log, queries, pools, release, end, client, uncaught, socketError };
  }
  const open = () => openDb("postgres://tester:secret@localhost:1/none");
  const discarded = (release: ReturnType<typeof vi.fn>) => Boolean(release.mock.calls[0]?.[0]);

  it("commits and returns the connection", async () => {
    const { log, release, client } = fakePool();
    const db = await open();
    let listening = 0;
    const value = await db.tx(async (tx) => {
      listening = client.listenerCount("error");
      await tx.query("select 1 as one");
      return "ok";
    });
    expect(value).toBe("ok");
    expect(log).toEqual(["begin", "select 1 as one", "commit"]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(discarded(release)).toBe(false);
    // Somebody listens for a lost connection while the transaction holds the client, and nobody is
    // left on it afterwards: the pool reuses the client, and a listener per transaction would pile up.
    expect(listening).toBe(1);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("rolls back, keeps the original error and returns the connection", async () => {
    const { log, release, client } = fakePool();
    const db = await open();
    await expect(
      db.tx(async (tx) => {
        await tx.query("select 1 as one");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(log).toEqual(["begin", "select 1 as one", "rollback"]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(discarded(release)).toBe(false);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("rolls back after a failed statement or a failed commit", async () => {
    const statement = fakePool(/boom_table/);
    let db = await open();
    await expect(db.tx((tx) => tx.query("select * from boom_table"))).rejects.toThrow(/boom_table/);
    expect(statement.log).toEqual(["begin", "select * from boom_table", "rollback"]);
    vi.restoreAllMocks();

    const commit = fakePool(/^commit$/);
    db = await open();
    await expect(db.tx((tx) => tx.query("select 1"))).rejects.toThrow(/commit/);
    expect(commit.log).toEqual(["begin", "select 1", "commit", "rollback"]);
    expect(discarded(commit.release)).toBe(false);
  });

  it("throws a connection away when it can not even roll back", async () => {
    const { release } = fakePool(/^rollback$/);
    const db = await open();
    await expect(
      db.tx(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(release).toHaveBeenCalledTimes(1);
    expect(discarded(release)).toBe(true);
  });

  it("refuses a transaction handle that outlived its transaction", async () => {
    const { log } = fakePool();
    const db = await open();
    const kept: Db[] = [];
    await db.tx(async (tx) => {
      kept.push(tx);
    });
    const before = log.length;
    await expect(kept[0]?.query("select 2")).rejects.toThrow("transaction is closed");
    expect(log).toHaveLength(before);
  });

  // pg-pool takes its own 'error' listener off a client that is checked out. A connection that drops
  // meanwhile makes pg emit 'error' on a client nobody listens to, which Node raises as an uncaught
  // exception: the whole process dies, not just the transaction. The transaction must fail alone.
  it.each([
    {
      when: "between two statements",
      dropOn: undefined,
      failsWith: /not queryable/,
      body: async (tx: Db, socketError: (error: Error) => void) => {
        await tx.query("select 1");
        socketError(new Error("read ECONNRESET"));
        await tx.query("select 2");
      },
    },
    {
      when: "after the last statement, so the commit finds it",
      dropOn: undefined,
      failsWith: /not queryable/,
      body: async (tx: Db, socketError: (error: Error) => void) => {
        await tx.query("select 1");
        socketError(new Error("read ECONNRESET"));
      },
    },
    {
      when: "while a statement is running",
      dropOn: /^select 2$/,
      failsWith: /Connection terminated unexpectedly/,
      body: async (tx: Db) => {
        await tx.query("select 1");
        await tx.query("select 2");
      },
    },
  ])("fails the transaction, not the process, when the connection drops $when", async (c) => {
    const { client, release, uncaught, socketError } = fakePool(undefined, c.dropOn);
    const db = await open();
    await expect(db.tx((tx) => c.body(tx, socketError))).rejects.toThrow(c.failsWith);
    expect(uncaught).toEqual([]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(discarded(release)).toBe(true);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("returns what Postgres sends in the same shapes as PGlite", async () => {
    const { pools } = fakePool();
    await open();
    // The pool's own parsers, fed the text a server sends for the probe's literal row.
    const types = pools[0]?.options.types;
    const parse = (oid: number, text: string) => types?.getTypeParser(oid, "text")(text);
    expect({
      numeric_value: parse(1700, U128_MAX),
      bigint_value: parse(20, "9007199254740993"),
      numeric_array_value: parse(1231, `{${U128_MAX},1}`),
      int8_array_value: parse(1016, "{9007199254740993,1,NULL}"),
      int_value: parse(23, "7"),
      float_value: parse(701, "1.5"),
      bool_value: parse(16, "t"),
      jsonb_value: parse(3802, '{"a": [1, "x", null]}'),
      bytea_value: parse(17, "\\x00ff10"),
      timestamptz_value: parse(1184, "2026-10-29 12:00:00+00"),
      null_value: null,
    }).toStrictEqual(EXPECTED_PROBE.literals);
  });

  it("keeps ids, counts and amounts as text when the whole process parses them as numbers", async () => {
    const { pools } = fakePool();
    // What some other module in the process may have done: pg's own switch (int8 and int8[] become
    // JS numbers for every pool without parsers of its own) and a common snippet for numeric.
    const defaultNumeric = pg.types.getTypeParser(1700);
    pg.defaults.parseInt8 = true;
    pg.types.setTypeParser(1700, parseFloat);
    try {
      await open();
      const types = pools[0]?.options.types;
      const parse = (oid: number, text: string) => types?.getTypeParser(oid, "text")(text);
      expect(parse(20, "9007199254740993")).toBe("9007199254740993");
      expect(parse(1016, "{9007199254740993,1,NULL}")).toEqual(["9007199254740993", "1", null]);
      expect(parse(1700, U128_MAX)).toBe(U128_MAX);
    } finally {
      pg.defaults.parseInt8 = false;
      pg.types.setTypeParser(1700, defaultNumeric);
    }
  });

  it("gives the pool a connection timeout, so an unreachable host fails in seconds", async () => {
    const { pools } = fakePool();
    await open();
    expect(pools[0]?.options.connectionTimeoutMillis).toBe(10_000);
  });

  it.each(["postgres", "postgresql"])("opens %s:// urls through the pool", async (scheme) => {
    const { pools } = fakePool();
    const url = `${scheme}://tester:secret@localhost:1/none`;
    const db = await openDb(url);
    expect(pools[0]?.options.connectionString).toBe(url);
    await db.close();
  });

  it("logs an idle connection that fails instead of letting it crash the process", async () => {
    const { pools } = fakePool();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await open();
    // An EventEmitter throws on 'error' when nobody listens, and the pool is no exception.
    expect(() => pools[0]?.emit("error", new Error("idle connection reset"))).not.toThrow();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[0])).toContain("idle connection reset");
  });

  it("hands pg parameters it binds the way PGlite does", async () => {
    const { queries } = fakePool();
    const db = await open();
    const bytes = new Uint8Array([7, 8]);
    const sql = "insert into t values ($1, $2, $3, $4, $5, $6, $7, $8)";
    await db.query(sql, [
      5n,
      ["a", "b"],
      { c: [1], d: 2n },
      undefined,
      bytes,
      bytes.buffer,
      new Date(0),
      "text",
    ]);
    await db.exec("select 1; select 2");
    expect(queries.slice(1)).toEqual([
      {
        text: sql,
        queryMode: "extended",
        values: ["5", ["a", "b"], '{"c":[1],"d":"2"}', null, bytes, bytes, new Date(0), "text"],
      },
      "select 1; select 2",
    ]);
  });

  it("closes the pool once", async () => {
    const { end } = fakePool();
    const db = await open();
    await db.close();
    await db.close();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("runs savepoints inside a transaction", async () => {
    const { log } = fakePool();
    const db = await open();
    await db.tx(async (tx) => {
      await tx.tx(async (inner) => {
        await inner.query("select 1");
      });
      await expect(
        tx.tx(async () => {
          throw new Error("inner");
        }),
      ).rejects.toThrow("inner");
    });
    expect(log).toEqual([
      "begin",
      expect.stringMatching(/^savepoint \w+$/),
      "select 1",
      expect.stringMatching(/^release savepoint \w+$/),
      expect.stringMatching(/^savepoint \w+$/),
      expect.stringMatching(/^rollback to savepoint \w+$/),
      expect.stringMatching(/^release savepoint \w+$/),
      "commit",
    ]);
  });

  it("closes the pool and reports the error when the first query fails", async () => {
    fakePool();
    vi.spyOn(pg.Pool.prototype, "query").mockImplementation((async () => {
      throw new Error("connect ECONNREFUSED");
    }) as never);
    const end = vi.spyOn(pg.Pool.prototype, "end").mockImplementation((async () => {}) as never);
    await expect(open()).rejects.toThrow("ECONNREFUSED");
    expect(end).toHaveBeenCalledTimes(1);
  });
});

it.skipIf(!POSTGRES_URL)("both_adapters_same_row_shapes", MINUTE, async () => {
  if (!POSTGRES_URL) return;
  const [a, b] = await Promise.all([pgliteTarget.fresh(), postgresTarget(POSTGRES_URL).fresh()]);
  try {
    await Promise.all([migrate(a.db), migrate(b.db)]);
    const fromPglite = await probeRows(a.db);
    const fromPostgres = await probeRows(b.db);
    expect(fromPostgres).toStrictEqual(fromPglite);
    expect(fromPostgres).toStrictEqual(EXPECTED_PROBE);
  } finally {
    await a.dispose();
    await b.dispose();
  }
});
