-- Tender schema, migration 0001. Later changes go in new numbered files, never in this one.
--
-- Every u64 and u128 (task ids, amounts, block heights) and every nanosecond timestamp is
-- numeric(40,0): 2^128 - 1 has 39 digits. Drivers disagree on how to return numeric and bigint
-- columns, so queries select them ::text and TypeScript converts with BigInt().
--
-- A column is NOT NULL unless it is marked as nullable here (no "not null" and no default).

create table chain_cursor (
  source text primary key,
  height numeric(40,0) not null
);

-- One row per contract event log line. unique (receipt_id, log_index) makes replaying a block a no-op.
-- task_id is the task the event is about, copied out of data by the indexer: data.task_id, or data.id
-- for task_created, which carries its id as "id". It is null for an event that names no task.
-- The event stream (SSE), the notifier and the web app filter on it.
create table events (
  id bigserial primary key,
  height numeric(40,0) not null,
  block_ts numeric(40,0) not null,
  receipt_id text not null,
  log_index int not null,
  event text not null,
  data jsonb not null,
  task_id numeric(40,0),
  unique (receipt_id, log_index)
);
create index events_task_id_idx on events (task_id);

create table tasks (
  id numeric(40,0) primary key,
  poster text not null,
  token text not null,
  reward numeric(40,0) not null,
  fee_bps int not null,
  brief_uri text not null,
  brief_hash text not null,
  criteria_hash text not null,
  heldout_commitment text,
  verifier text not null,
  created_at numeric(40,0) not null,
  commit_deadline numeric(40,0) not null,
  reveal_deadline numeric(40,0) not null,
  pick_deadline numeric(40,0) not null,
  fallback_deadline numeric(40,0) not null,
  max_entries int not null,
  max_winners int not null,
  invited jsonb not null,
  parent numeric(40,0),
  commit_count int not null default 0,
  reveal_count int not null default 0,
  outcome jsonb,
  settled_height numeric(40,0),
  title text,
  category text,
  tags jsonb not null default '[]',
  judge_status text,
  judge_reason text,
  created_height numeric(40,0) not null
);
create index tasks_poster_idx on tasks (poster);
create index tasks_verifier_idx on tasks (verifier);
create index tasks_parent_idx on tasks (parent);
create index tasks_commit_deadline_idx on tasks (commit_deadline);

create table funders (
  task_id numeric(40,0) not null,
  account text not null,
  amount numeric(40,0) not null,
  primary key (task_id, account)
);

create table entries (
  task_id numeric(40,0) not null,
  account text not null,
  entry_index int not null,
  commitment text not null,
  committed_height numeric(40,0) not null,
  content_hash text,
  uri text,
  primary key (task_id, account)
);

create table agents (
  account text primary key,
  asp text,
  profile_uri text not null,
  profile_hash text not null,
  tags jsonb not null,
  name text,
  entries int not null default 0,
  reveals int not null default 0,
  wins int not null default 0,
  earned jsonb not null default '{}',
  picks_made int not null default 0,
  voids_after_reveals int not null default 0,
  registered_height numeric(40,0) not null,
  is_team boolean not null default false
);

-- Content-addressed: sha256 is the hash of bytes, computed by putBlob, never supplied by a caller.
create table blobs (
  sha256 text primary key,
  kind text not null check (kind in ('brief', 'criteria', 'heldout', 'result', 'scorecard', 'profile')),
  content_type text not null,
  bytes bytea not null,
  task_id numeric(40,0),
  uploader text,
  is_public boolean not null,
  created_at timestamptz not null default now()
);

create table working (
  task_id numeric(40,0) not null,
  account text not null,
  started_at timestamptz not null default now(),
  primary key (task_id, account)
);

create table auth_challenges (
  nonce text primary key,
  expires_at timestamptz not null,
  used boolean not null default false
);

create table auth_tokens (
  token_sha256 text primary key,
  account text not null,
  public_key text not null,
  key_kind text not null,
  expires_at timestamptz not null
);

create table tg_links (
  chat_id bigint primary key,
  account text not null,
  muted boolean not null default false,
  linked_at timestamptz not null default now()
);

create table tg_link_nonces (
  nonce text primary key,
  account text not null,
  expires_at timestamptz not null,
  used boolean not null default false
);

create table tg_watches (
  chat_id bigint not null,
  tag text not null,
  primary key (chat_id, tag)
);

create table tg_sent (
  chat_id bigint not null,
  dedupe_key text not null,
  sent_at timestamptz not null default now(),
  primary key (chat_id, dedupe_key)
);

create table worker_cursor (
  name text primary key,
  event_id bigint not null
);
