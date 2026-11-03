-- Tender schema, migration 0003. Later changes go in new numbered files, never in this one.
-- The conventions of 0001 hold: a column is NOT NULL unless it is marked as nullable (no "not null"
-- and no default).

-- Which accounts uploaded which held-out document. `blobs` keeps only the first upload of some
-- bytes, and whoever has the bytes can send them first: the held-out documents of the seeds are in
-- the repository, for one. So every account that sends a held-out document is recorded here, and
-- the Judge takes a task's held-out checks when the task's poster is among them, whoever was first.
create table heldout_uploads (
  sha256 text not null,
  account text not null,
  uploaded_at timestamptz not null default now(),
  primary key (sha256, account)
);

-- Held-out documents stored before this table existed: the row's uploader is the one upload that
-- was kept, and it dates from then. With no row, the Judge would take the checks of no task whose
-- held-out document was sent before the upgrade.
insert into heldout_uploads (sha256, account, uploaded_at)
select sha256, uploader, created_at from blobs
 where kind = 'heldout' and uploader is not null;
