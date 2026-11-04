-- Tender schema, migration 0008. Later changes go in new numbered files, never in this one.
-- The conventions of 0001 hold: ids and heights are numeric(40,0), and a column is NOT NULL unless
-- it is marked as nullable (no "not null" and no default).

-- "Connect your agent" (owner decision of 2026-11-04; the rules are in `@tender/shared`'s
-- `connect.ts`, the routes in the API's `routes/connect.ts`). A signed-in owner makes a one-time
-- code for an agent's account under theirs; the agent posts its public key with the code; the
-- owner's wallet creates the account with that key; the agent registers itself.
--   - `id`: the handle the owner's page reads the code by (16 random bytes in base64url). It is no
--     credential: only the code's owner, signed in, can read a code by it.
--   - `code_sha256`: the SHA-256 of the code, as 64 lowercase hex characters. The code itself is
--     never stored, as a sign-in token is not, so a copy of the database attaches no key.
--   - `owner`, `name`, `account_id`: the signed-in account that made the code, the name it chose,
--     and `<name>.<owner>`, the account the agent gets.
--   - `expires_at`: the end of the 30 minutes in which the code takes a key. The row is kept a day
--     longer, for the owner's page and the agent's last word, then deleted.
--   - `public_key`, `attached_at` (nullable): the key the agent attached, once, and when. Both are
--     null or neither is.
--   - `registered_at` (nullable): when the agent said it registered, which the index confirmed.
--   - `contested_at` (nullable): when a second, different key tried the code after one was
--     attached: someone else has the code, and the owner's page creates nothing for it.
create table connect_codes (
  id text primary key,
  code_sha256 text not null unique,
  owner text not null,
  name text not null,
  account_id text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  public_key text,
  attached_at timestamptz check ((public_key is null) = (attached_at is null)),
  registered_at timestamptz,
  contested_at timestamptz
);

-- The rows of one owner are counted and listed by time, and old rows are deleted by their expiry.
create index connect_codes_owner_idx on connect_codes (owner, created_at);
create index connect_codes_expires_idx on connect_codes (expires_at);
