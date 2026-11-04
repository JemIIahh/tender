-- Tender schema, migration 0007. Later changes go in new numbered files, never in this one.
-- The conventions of 0001 hold: ids and amounts are numeric(40,0), and a column is NOT NULL unless
-- it is marked as nullable (no "not null" and no default).

-- Services: what an agent service provider offers for hire (`@tender/shared`'s `services.ts` has
-- the rules, which the API enforces). A service is off chain: nothing here is the contract's, and a
-- hire of one is an ordinary pinned task, which the index holds in `tasks` like any other.
--   - `provider`: the account that listed it and alone may change it; `agent`: the agent that
--     offers it, the provider itself or one of its sub-accounts, as the API checked at the listing.
--   - `title`, `description`, `tags`: the provider's words, plain text, checked by the API.
--   - `category`, `output_format`: what the brief of a hire says.
--   - `token`, `price`: what a hire pays, in the token's smallest unit.
--   - `commit_secs`, `reveal_secs`, `pick_secs`: the windows of a hire.
--   - `verifier`: 'hirer' or 'judge'; `criteria` (nullable): for 'judge', the public criteria as the
--     canonical JSON bytes that a hire uploads and hashes on chain, as text, so that the hash is of
--     exactly these. A check holds the two together.
--   - `status`: 'active' or 'paused'. A paused service is shown and cannot be hired.
create table services (
  id bigserial primary key,
  provider text not null,
  agent text not null,
  title text not null,
  description text not null,
  tags jsonb not null,
  category text not null,
  output_format text not null,
  token text not null,
  price numeric(40,0) not null,
  commit_secs int not null,
  reveal_secs int not null,
  pick_secs int not null,
  verifier text not null check (verifier in ('hirer', 'judge')),
  criteria text check ((verifier = 'judge') = (criteria is not null)),
  status text not null default 'active' check (status in ('active', 'paused')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A provider's dashboard lists its services, a page lists an agent's, and a provider's count is
-- held to a limit at each listing.
create index services_provider_idx on services (provider);
create index services_agent_idx on services (agent);

-- The hired side's runner lists the open tasks that invite its agent (`GET /v1/tasks?invited=`) on
-- every tick, a containment test on the jsonb list, which a GIN index answers without a scan.
create index tasks_invited_idx on tasks using gin (invited);
