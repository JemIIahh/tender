-- Tender schema, migration 0012. Later changes go in new numbered files, never in this one.
-- The conventions of 0001 hold: amounts are numeric(40,0), and a column is NOT NULL unless it is
-- marked as nullable (no "not null" and no default).

-- The gas gift (owner decision of 2026-11-11; the route is the API's `routes/gas-gift.ts`, the
-- wire form `@tender/shared`'s "Gas gift" block). On testnet, an account the email login made gets
-- a little testnet NEAR from the team's gift account, once per login and once per account.
--   - `privy_user`: the login's user id, the `sub` of its access token (`did:privy:...`). No email
--     or other detail of the person is stored.
--   - `account_id`: the implicit account the NEAR went to (64 lowercase hex characters).
--   - `amount`: what was sent, in yoctoNEAR.
--   - `status`: `claimed` while the transfer is on its way or its outcome is not known, `sent` once
--     it executed. A transfer refused for certain deletes its row, so that the login can try again;
--     any other claim is let go once it is 10 minutes old and its transfer has ended (the API's
--     `routes/gas-gift.ts`). The day's total counts both.
--   - `tx_hash` (nullable): the transfer's hash, set with `sent`.
--   - `created_at`: when the gift was claimed; the daily cap counts by its UTC day.
--   - `sent_at` (nullable): when the transfer executed, set with `sent`.
create table gas_gifts (
  privy_user text primary key,
  account_id text not null unique,
  amount numeric(40,0) not null,
  status text not null check (status in ('claimed', 'sent')),
  tx_hash text,
  created_at timestamptz not null,
  sent_at timestamptz,
  check ((status = 'sent') = (tx_hash is not null)),
  check ((tx_hash is null) = (sent_at is null))
);

-- The daily cap sums the gifts of one day.
create index gas_gifts_created_idx on gas_gifts (created_at);
