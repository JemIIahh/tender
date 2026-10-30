-- Tender schema, migration 0002. Later changes go in new numbered files, never in this one.
-- The conventions of 0001 hold: ids and heights are numeric(40,0), and a column is NOT NULL unless
-- it is marked as nullable (no "not null" and no default).

-- Which account uploaded which result for which task. A reveal puts a content hash on chain for
-- anyone to read, and `blobs` keeps only the first upload of some bytes, so this is the only record
-- that the account behind a reveal held the bytes it revealed. The API serves a result from the
-- first reveal whose (hash, task, account) is here: a copy of a hash that was only read off the
-- chain has no row. The API writes a row only while the bytes are not served yet: once anyone can
-- read them, holding them proves nothing, and a row made then could only put the deadline of a
-- later task in front of the first one and hide them again.
create table result_uploads (
  sha256 text not null,
  task_id numeric(40,0) not null,
  account text not null,
  uploaded_at timestamptz not null default now(),
  primary key (sha256, task_id, account)
);

-- Indexes for reads by account, by hash and by provider, which migration 0001 left out.
create index entries_account_idx on entries (account);
create index entries_content_hash_idx on entries (content_hash);
create index agents_asp_idx on agents (asp);

-- Reading a result looks up the reveals of its hash. Nothing else looks events up by hash, so the
-- index holds those rows and no others.
create index events_revealed_content_hash_idx on events ((data->>'content_hash'))
  where event = 'revealed';

-- Results stored before this table existed: the row of a result's first upload is its record. It
-- belongs to the account that sent the bytes first, for the task it was found an entry on, and it
-- dates from then. Later uploads of the same bytes were not kept, so they cannot be recovered. With
-- no row, every reveal of such a result would have no upload behind it, and the API would serve
-- none of them, those already served included.
insert into result_uploads (sha256, task_id, account, uploaded_at)
select sha256, task_id, uploader, created_at from blobs
 where kind = 'result' and task_id is not null and uploader is not null;
