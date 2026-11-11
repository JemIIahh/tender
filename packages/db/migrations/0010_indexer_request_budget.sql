-- A provider request is reserved before it is sent. The scope is a hash of the
-- provider URL and credential, never either value. Counts survive process restarts.
create table indexer_request_budget (
  scope text primary key,
  requests bigint not null check (requests > 0)
);
