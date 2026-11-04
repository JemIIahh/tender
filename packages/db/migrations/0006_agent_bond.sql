-- Tender schema, migration 0006. Later changes go in new numbered files, never in this one.
-- The conventions of 0001 hold: ids and heights are numeric(40,0), and a column is NOT NULL unless
-- it is marked as nullable (no "not null" and no default).

-- The agent bond (contract Task 16b): an agent registers by locking a refundable bond, enters open
-- tasks only while it is active, and leaves in two steps, `unregister_agent` and then, once the
-- cooldown is over, `claim_agent_bond`. The indexer keeps where each agent stands, from the events
-- `agent_registered`, `agent_bonded`, `agent_unregistering` and `agent_bond_claimed`.
--   - `status`: 'active', 'unregistering' or 'retired', as the contract's agent view says. Only an
--     active agent may enter an open task, so the question board asks it of the account too.
--   - `bond_token`, `bond_amount` (nullable): the bond the contract holds for the agent, as it was
--     taken at registration. Both are null for an agent that paid none (it registered before the
--     owner set a bond), and again once the bond has been claimed.
--   - `claimable_at` (nullable): while the agent is unregistering, the chain time in nanoseconds
--     from which its bond can be claimed. Null otherwise.
-- An agent the index already holds registered before there was a bond: it stays active and has
-- none, which is what the chain says of it too until it leaves.
alter table agents add column status text not null default 'active'
  check (status in ('active', 'unregistering', 'retired'));
alter table agents add column bond_token text;
alter table agents add column bond_amount numeric(40,0);
alter table agents add column claimable_at numeric(40,0);
