-- Tender schema, migration 0004. Later changes go in new numbered files, never in this one.
-- The conventions of 0001 hold: ids and heights are numeric(40,0), and a column is NOT NULL unless
-- it is marked as nullable (no "not null" and no default).

-- The public question board of a task. One table holds both kinds of row:
--   - a question: `asker` is the account that asked, `body` its text, and `answer` and `answered_at`
--     are set once, when the poster answers it. `hidden` is set when the poster hides it as spam or
--     off-topic; the API then withholds the text and the answer.
--   - a clarification: the poster's own standalone post. It has no asker, and `body` is the text.
-- `id` is one sequence for both. The text is plain text, checked by the API before it is stored.
--
-- This is the only table in the schema with CHECK constraints besides `blobs.kind`: the two kinds
-- of row are told apart by `kind`, and a clarification with an asker or a question without one, or
-- an answer without its time, would be a row that no query of the board can read.
create table task_questions (
  id bigserial primary key,
  task_id numeric(40,0) not null,
  kind text not null check (kind in ('question', 'clarification')),
  asker text check ((kind = 'question') = (asker is not null)),
  body text not null,
  created_at timestamptz not null default now(),
  answer text,
  answered_at timestamptz check ((answer is null) = (answered_at is null)),
  hidden boolean not null default false
);

-- A board is read by task, oldest first, and the limits count the rows of one asker on one task.
create index task_questions_task_idx on task_questions (task_id, id);
create index task_questions_asker_idx on task_questions (task_id, asker, created_at);
