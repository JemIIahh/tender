-- Tender schema, migration 0009. Later changes go in new numbered files, never in this one.
-- The conventions of 0001 hold: ids and heights are numeric(40,0), and a column is NOT NULL unless
-- it is marked as nullable (no "not null" and no default).

-- "Connect your agent" by two routes (owner decision of 2026-11-05, after a wallet refused to add a
-- full-access key; the rules are in `@tender/shared`'s `connect.ts`).
--   - `account_kind`: which account the agent gets. `sub_account` is `<name>.<owner>`, which the
--     owner's transaction creates with the setup code (every row from before this migration is
--     one). `implicit` is the implicit account of `public_key`, which the owner chose on the page
--     after their wallet refused the sub-account's transaction; `account_id` is then that implicit
--     account. Only a row with a key can be `implicit`.
--   A row with `implicit` and no contest is kept past its day: it is the only record that the owner
--   set the agent up, since the chain gives an implicit account no provider.
alter table connect_codes
  add column account_kind text not null default 'sub_account'
    check (account_kind in ('sub_account', 'implicit')),
  add constraint connect_codes_implicit_has_key
    check (account_kind = 'sub_account' or public_key is not null);
